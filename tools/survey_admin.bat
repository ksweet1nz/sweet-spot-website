@echo off
rem Starts the local survey admin page with GDAL available.
rem GDAL comes from QGIS (preferred, it includes gdal2tiles) or OSGeo4W.
setlocal
set "O4W="
for /d %%Q in ("%ProgramFiles%\QGIS*") do if exist "%%Q\bin\o4w_env.bat" set "O4W=%%Q\bin\o4w_env.bat"
if not defined O4W if exist "C:\OSGeo4W\bin\o4w_env.bat" set "O4W=C:\OSGeo4W\bin\o4w_env.bat"
if not defined O4W (
  echo GDAL not found. Install QGIS or OSGeo4W, then run this again.
  pause
  exit /b 1
)
call "%O4W%"
for /d %%P in ("%OSGEO4W_ROOT%\apps\Python3*") do set "PATH=%%P\Scripts;%PATH%"
python "%~dp0survey_admin.py" %*
if errorlevel 1 pause
