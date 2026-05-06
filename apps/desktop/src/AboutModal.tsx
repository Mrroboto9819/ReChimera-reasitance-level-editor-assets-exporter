import iconUrl from "../icon.png?url";
import { Modal } from "./Modal";
import { APP_VERSION, APP_REPO_URL, APP_ISSUES_URL } from "./version";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

interface CreditEntry {
  /** GitHub handle, used for both the displayed @name and the URL. */
  handle: string;
  /** One-line role / contribution. Mirrors the README's People section
   *  so credits stay in sync between the in-app Modal and the public
   *  README — when adding contributors, update both. */
  contribution: string;
}

const PEOPLE: CreditEntry[] = [
  {
    handle: "VELD-Dev",
    contribution:
      "Author of ReLunacy — the C# / Unity predecessor that ReChimera ports its parser and rendering approach from. Lead maintainer of this project.",
  },
  {
    handle: "NefariousTechSupport",
    contribution:
      "Original developer of Lunacy and key reverse engineer for the PS3-era Insomniac titles. ReChimera's renderer is directly inspired by their 7th igRewrite (Skylanders level editor).",
  },
  {
    handle: "PredatorCZ",
    contribution:
      "Pioneer of Ratchet & Clank: Future-series reverse engineering and author of InsomniaToolset + the Spike framework. Most of our SCREAM / IGHW / pointer-resolution rules come from cross-referencing their headers.",
  },
  {
    handle: "Nooga",
    contribution:
      "Artist behind ReLunacy's logo, which set the visual identity that this project's branding follows.",
  },
];

/**
 * About / credits modal — mirrors the People section of the README
 * inside the app. Open via `Help → About ReChimera`.
 *
 * The list of contributors is intentionally inline (not loaded from an
 * external file) so it appears even when the app runs offline. Keep
 * `PEOPLE` in sync with the README's `### People` block — when adding
 * a contributor, update both spots in the same commit.
 */
export function AboutModal({ open, onClose }: AboutModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`About ReChimera v${APP_VERSION}`}
      subtitle="Offline level inspector and asset extractor for Insomniac Games' PS3 titles"
      size="lg"
      footer={
        <>
          <a
            href={APP_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            View on GitHub
          </a>
          <a
            href={APP_ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            Report an issue
          </a>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="about-modal">
        <header className="about-header">
          <img src={iconUrl} alt="ReChimera" className="about-logo" />
          <div className="about-header-text">
            <div className="about-name">ReChimera</div>
            <div className="about-version mono small">
              v{APP_VERSION} · Beta
            </div>
            <div className="about-tagline small dim">
              Resistance: Fall of Man · Resistance 2 · Resistance 3 ·
              Ratchet &amp; Clank Future trilogy
            </div>
          </div>
        </header>

        <section className="about-section">
          <h3 className="about-section-title">Credits</h3>
          <p className="small dim">
            ReChimera stands on the shoulders of years of community
            reverse-engineering on Insomniac's PS3 engine. Heartfelt thanks
            to:
          </p>
          <ul className="about-people">
            {PEOPLE.map((p) => (
              <li key={p.handle} className="about-person">
                <a
                  href={`https://github.com/${p.handle}`}
                  target="_blank"
                  rel="noreferrer"
                  className="about-handle"
                >
                  @{p.handle}
                </a>
                <span className="about-contribution small">
                  {p.contribution}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="about-section">
          <h3 className="about-section-title">Reference projects</h3>
          <ul className="about-refs small">
            <li>
              <a
                href="https://github.com/RatchetModding/ReLunacy"
                target="_blank"
                rel="noreferrer"
              >
                ReLunacy / LibLunacy
              </a>{" "}
              <span className="dim">— GPL-3.0, by @VELD-Dev</span>
            </li>
            <li>
              <a
                href="https://github.com/PredatorCZ/InsomniaToolset"
                target="_blank"
                rel="noreferrer"
              >
                InsomniaToolset
              </a>{" "}
              <span className="dim">— GPL-3.0, by @PredatorCZ</span>
            </li>
            <li>
              <a
                href="https://github.com/PredatorCZ/Spike"
                target="_blank"
                rel="noreferrer"
              >
                Spike framework
              </a>{" "}
              <span className="dim">— BSD-3-Clause</span>
            </li>
            <li>
              <a
                href="https://github.com/NefariousTechSupport/7thigRewrite"
                target="_blank"
                rel="noreferrer"
              >
                7th igRewrite
              </a>{" "}
              <span className="dim">— renderer inspiration</span>
            </li>
          </ul>
        </section>

        <section className="about-section">
          <h3 className="about-section-title">License</h3>
          <p className="small dim">
            Distributed under{" "}
            <strong>GPL-3.0-or-later</strong>. See the LICENSE and
            NOTICE.md files in the repository for the full text and
            third-party attributions. Game data is not included; you
            must supply your own legitimately-acquired files.
          </p>
        </section>
      </div>
    </Modal>
  );
}
