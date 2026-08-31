export const projectBasePath = "/cedar-tv-updates";

export const footerStylesheet = `    <link rel="stylesheet" href="${projectBasePath}/footer.css">`;

export function renderSiteFooter() {
  return `      <footer class="site-footer">
        <div class="site-footer-intro">
          <a class="site-footer-brand" href="${projectBasePath}/" aria-label="Cedar home">
            <img src="${projectBasePath}/assets/cedar-app-icon.png" alt="" width="36" height="36" aria-hidden="true">
            <span>Cedar</span>
          </a>
          <p>A focused media player and organizer for the screens you already own. Connect only sources and services you are authorized to use.</p>
          <div class="site-footer-socials" aria-label="Cedar community">
            <a class="site-footer-social" href="https://discord.gg/TFTx7j86v" aria-label="Join Cedar on Discord">
              <img src="${projectBasePath}/assets/discord-symbol.svg" alt="" width="21" height="16" aria-hidden="true">
            </a>
          </div>
        </div>

        <nav class="site-footer-nav" aria-label="Footer navigation">
          <section class="site-footer-group">
            <h2>Products</h2>
            <ul>
              <li><a href="${projectBasePath}/">Android TV</a></li>
              <li><a href="${projectBasePath}/apple/">Apple apps</a></li>
              <li><a href="${projectBasePath}/link/">Cedar Link</a></li>
              <li><a href="${projectBasePath}/releases/">Release notes</a></li>
            </ul>
          </section>
          <section class="site-footer-group">
            <h2>Resources</h2>
            <ul>
              <li><a href="${projectBasePath}/support/">Support</a></li>
              <li><a href="${projectBasePath}/privacy/">Privacy</a></li>
              <li><a href="${projectBasePath}/accessibility/">Accessibility</a></li>
              <li><a href="${projectBasePath}/content-policy/">Content policy</a></li>
            </ul>
          </section>
          <section class="site-footer-group">
            <h2>Community</h2>
            <ul>
              <li><a href="https://discord.gg/TFTx7j86v">Discord</a></li>
              <li><a href="https://github.com/CedarTV/cedar-tv-updates/issues">Report an issue</a></li>
              <li><a href="https://github.com/CedarTV/cedar-tv-updates">GitHub</a></li>
              <li><a href="${projectBasePath}/update-v1.json">Android manifest</a></li>
            </ul>
          </section>
        </nav>

        <p class="site-footer-meta">
          <span>© 2026 Cedar</span>
          <span>Cedar does not provide, host, or sell media content.</span>
        </p>
      </footer>`;
}
