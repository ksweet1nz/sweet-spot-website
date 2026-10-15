#!/usr/bin/env python3
"""
Local admin page for published surveys.

Lists the surveys in the data bucket and lets you add a new one from a
DJI Terra folder, edit its details, replace its link or delete it. Start
it with tools/survey_admin.bat (which loads GDAL), then use the page it
opens in your browser.

The page is only served to this PC (127.0.0.1) and every request must
carry a key generated at start-up, so other sites and other machines
cannot drive it. It needs rclone with a remote for the bucket, and GDAL
for adding surveys (see survey/README.md).
"""

import argparse
import glob
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

TOOLS = Path(__file__).resolve().parent
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{6,128}")
EDITABLE = ("title", "client", "date", "location", "description", "expires")
RCLONE_NOISE = ("Transferred:", "Checks:", "Elapsed time:", "Transferring:", "*", "Errors:", "Deleted:", "Renamed:",
                "Checking:")
# Access log settings written when the log Worker was set up: {"logUrl": ..., "logKey": ...}
LOG_CONFIG = Path(os.environ.get("APPDATA", str(Path.home()))) / "SweetSpot" / "survey-admin.json"

ARGS = None
KEY = secrets.token_urlsafe(24)


# ---------- rclone ----------

def find_rclone():
    """Put rclone on PATH if winget installed it but this shell predates it."""
    if shutil.which("rclone"):
        return True
    pattern = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages",
                           "Rclone.Rclone_*", "**", "rclone.exe")
    hits = glob.glob(pattern, recursive=True)
    if hits:
        os.environ["PATH"] = os.path.dirname(hits[0]) + os.pathsep + os.environ["PATH"]
    return bool(hits)


def rclone(*args, stdin=None):
    out = subprocess.run(["rclone", *args], input=stdin, capture_output=True, text=True, encoding="utf-8")
    if out.returncode:
        raise RuntimeError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "rclone failed")
    return out.stdout


def remote(token, *parts):
    return "/".join([ARGS.remote.rstrip("/"), token, *parts])


def read_project(token):
    return json.loads(rclone("cat", remote(token, "project.json")))


def log_api(path):
    """Call the access-log Worker (worker/). None when it isn't set up on this PC."""
    if not LOG_CONFIG.exists():
        return None
    cfg = json.loads(LOG_CONFIG.read_text(encoding="utf-8"))
    req = urllib.request.Request(cfg["logUrl"].rstrip("/") + "/" + path,
                                 headers={"Authorization": "Bearer " + cfg["logKey"], "User-Agent": "survey-admin"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def list_surveys():
    tokens = [t.rstrip("/") for t in rclone("lsf", ARGS.remote, "--dirs-only").splitlines()]
    tokens = [t for t in tokens if TOKEN_RE.fullmatch(t)]

    def load(token):
        entry = {"token": token, "link": ARGS.site_url + "#" + token}
        try:
            p = read_project(token)
            entry.update({k: p.get(k, "") for k in EDITABLE})
            entry["layers"] = [l.get("name", l.get("id")) for l in p.get("layers", [])]
            entry["downloads"] = len(p.get("downloads", []))
        except Exception as e:  # a folder without a readable project.json
            entry["error"] = str(e)
        return entry

    with ThreadPoolExecutor(8) as pool:
        surveys = list(pool.map(load, tokens))
    try:
        activity = log_api("summary")
    except Exception as e:  # the list still works without the log
        activity = {"error": str(e)}
    if activity and "surveys" in activity:
        by_token = {row["token"]: row for row in activity["surveys"]}
        for s in surveys:
            s["activity"] = by_token.get(s["token"], {"views": 0, "downloads": 0, "visitors": 0, "last": None})
    elif activity:
        for s in surveys:
            s["activityError"] = activity["error"]
    return sorted(surveys, key=lambda s: (s.get("date") or "", s.get("title") or ""), reverse=True)


def scan_terra(root):
    """Folders under root (two levels deep) that look like DJI Terra projects."""
    root = Path(root)
    if not root.is_dir():
        return []
    children = [d for d in root.iterdir() if d.is_dir()]
    grandchildren = [g for d in children for g in d.iterdir() if g.is_dir()]
    return sorted(str(c) for c in [root, *children, *grandchildren]
                  if (c / "map").is_dir() or (c / "models").is_dir())


# ---------- background job (one at a time) ----------

JOB = {"id": 0, "title": "", "running": False, "ok": None, "log": [], "status": "", "link": ""}
JOB_LOCK = threading.Lock()


def job_log(line):
    line = line.rstrip()
    if not line or "FutureWarning" in line or line.strip() == "warnings.warn(":
        return
    if line.strip().startswith(RCLONE_NOISE):
        if line.strip().startswith("Transferred:") and "%" in line:
            JOB["status"] = " ".join(line.split())
        return
    JOB["log"].append(line)


def job_run(cmd):
    job_log("$ " + " ".join(cmd[:2]) + " ...")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONUTF8="1"))
    for line in proc.stdout:
        job_log(line)
    if proc.wait():
        raise RuntimeError(f"{Path(cmd[0]).name} exited with code {proc.returncode}")


def start_job(title, work):
    with JOB_LOCK:
        if JOB["running"]:
            raise RuntimeError(f"Busy: {JOB['title']}. Wait for it to finish.")
        JOB.update({"id": JOB["id"] + 1, "title": title, "running": True, "ok": None,
                    "log": [], "status": "", "link": ""})

    def runner():
        try:
            work()
            JOB["ok"] = True
            job_log("Done.")
        except Exception as e:
            JOB["ok"] = False
            job_log(f"FAILED: {e}")
        finally:
            JOB["status"] = ""
            JOB["running"] = False

    threading.Thread(target=runner, daemon=True).start()


def publish(form):
    terra = (form.get("terra") or "").strip().strip('"')
    if not Path(terra).is_dir():
        raise RuntimeError("Terra folder not found: " + terra)
    if not (form.get("title") or "").strip():
        raise RuntimeError("A title is required.")
    token = form.get("token") or secrets.token_urlsafe(16)
    if not TOKEN_RE.fullmatch(token):
        raise RuntimeError("Invalid link token.")

    staging = Path(ARGS.staging)
    cmd = [sys.executable, "-u", str(TOOLS / "publish_survey.py"), terra, "--token", token,
           "--out", str(staging), "--upload", ARGS.remote, "--site-url", ARGS.site_url]
    for key in EDITABLE:
        if (form.get(key) or "").strip():
            cmd += ["--" + key, form[key].strip()]
    if form.get("downloads"):
        cmd.append("--downloads")

    def work():
        try:
            job_run(cmd)
        finally:
            # The bucket holds the published copy; don't keep gigabytes of staging.
            shutil.rmtree(staging / token, ignore_errors=True)
        JOB["link"] = ARGS.site_url + "#" + token

    start_job(f"Publishing {form['title'].strip()}", work)


def update(form):
    token = form["token"]
    p = read_project(token)
    for key in EDITABLE:
        if key in form:
            value = (form[key] or "").strip()
            if value:
                p[key] = value
            else:
                p.pop(key, None)
    if not p.get("title"):
        raise RuntimeError("A title is required.")
    rclone("rcat", remote(token, "project.json"), stdin=json.dumps(p, indent=2) + "\n")


def relink(form):
    old, new = form["token"], secrets.token_urlsafe(16)

    def work():
        job_run(["rclone", "move", remote(old), remote(new), "--transfers", "32", "--checkers", "32", "--progress"])
        JOB["link"] = ARGS.site_url + "#" + new

    start_job("Replacing link", work)


def delete(form):
    token = form["token"]
    start_job("Deleting survey", lambda: job_run(["rclone", "purge", remote(token)]))


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, body, status=200, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        # Host check stops DNS rebinding; the key stops other pages posting here.
        host_ok = self.headers.get("Host") in (f"127.0.0.1:{ARGS.port}", f"localhost:{ARGS.port}")
        return host_ok and secrets.compare_digest(self.headers.get("X-Admin-Key", ""), KEY)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            if parse_qs(url.query).get("key", [""])[0] != KEY:
                return self.reply(b"Open the link printed when survey_admin started.", 403, "text/plain")
            page = (TOOLS / "survey_admin.html").read_text(encoding="utf-8")
            return self.reply(page.encode(), ctype="text/html; charset=utf-8")
        if not self.allowed():
            return self.reply({"error": "Not allowed"}, 403)
        try:
            if url.path == "/api/surveys":
                return self.reply({"surveys": list_surveys(), "remote": ARGS.remote, "siteUrl": ARGS.site_url})
            if url.path == "/api/size":
                token = parse_qs(url.query)["token"][0]
                if not TOKEN_RE.fullmatch(token):
                    raise RuntimeError("Invalid link token.")
                return self.reply(json.loads(rclone("size", remote(token), "--json")))
            if url.path == "/api/activity":
                token = parse_qs(url.query)["token"][0]
                if not TOKEN_RE.fullmatch(token):
                    raise RuntimeError("Invalid link token.")
                result = log_api("log?token=" + urllib.parse.quote(token))
                if result is None:
                    raise RuntimeError(f"Access log not set up on this PC ({LOG_CONFIG} missing).")
                return self.reply(result)
            if url.path == "/api/scan":
                return self.reply({"folders": scan_terra(parse_qs(url.query).get("root", [""])[0])})
            if url.path == "/api/job":
                since = int(parse_qs(url.query).get("since", ["0"])[0])
                return self.reply(dict(JOB, log=JOB["log"][since:]))
        except Exception as e:
            return self.reply({"error": str(e)}, 500)
        self.reply({"error": "Not found"}, 404)

    def do_POST(self):
        if not self.allowed():
            return self.reply({"error": "Not allowed"}, 403)
        actions = {"/api/publish": publish, "/api/update": update, "/api/relink": relink, "/api/delete": delete}
        action = actions.get(urlparse(self.path).path)
        if not action:
            return self.reply({"error": "Not found"}, 404)
        try:
            form = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if action is not publish and not TOKEN_RE.fullmatch(form.get("token", "")):
                raise RuntimeError("Invalid link token.")
            action(form)
            self.reply({"ok": True})
        except Exception as e:
            self.reply({"error": str(e)}, 400)


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--remote", default="r2:surveys", help='rclone destination of the data bucket (default "r2:surveys")')
    ap.add_argument("--site-url", default="https://sweetspotadvisory.com.au/survey/", help="Public URL of the viewer page")
    ap.add_argument("--staging", default=str(TOOLS.parent / "published"), help="Local folder used while publishing")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true", help="Don't open the page automatically")
    ARGS = ap.parse_args()

    if not find_rclone():
        sys.exit("rclone not found. Install it from https://rclone.org/install/")
    if not shutil.which("gdalinfo"):
        print("Warning: GDAL not found, so adding surveys will fail. Start with tools/survey_admin.bat.")

    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    url = f"http://127.0.0.1:{ARGS.port}/?key={KEY}"
    print(f"Survey admin running. Open:\n  {url}\nPress Ctrl+C to stop.", flush=True)
    if not ARGS.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
