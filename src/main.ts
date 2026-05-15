import { renderAdminPage } from "./admin.ts";
import { matchAdminRoute, matchViewRoute } from "./routes.ts";
import { renderUploadPage } from "./upload.ts";
import { renderViewPage } from "./view.ts";

function router() {
  const path = window.location.pathname;
  const app = document.querySelector<HTMLDivElement>("#app")!;

  if (matchAdminRoute(path)) {
    renderAdminPage(app);
    return;
  }

  const match = matchViewRoute(path);
  if (match) {
    void renderViewPage(app, match.id);
    return;
  }

  renderUploadPage(app);
}

// Handle browser back/forward
window.addEventListener("popstate", router);

// Initial route
router();
