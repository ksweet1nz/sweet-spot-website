/* =============================================================
   SURVEY VIEWER — Site configuration
   ============================================================= */

window.SURVEY_CONFIG = {
  // Where published projects live. Each project is a folder named by its
  // access token containing project.json, e.g.
  //   https://surveys.sweetspotadvisory.com.au/<token>/project.json
  // When previewing on localhost, projects are read from survey/data/.
  dataBaseUrl: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "data/"
    : "https://surveys.sweetspotadvisory.com.au/",

  // Shown in the panel footer and error screens.
  contactEmail: "kevin@sweetspotadvisory.com.au",

  // Satellite basemap shown under (and around) the survey.
  basemap: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Basemap: Esri, Maxar, Earthstar Geographics",
    maximumLevel: 19
  }
};
