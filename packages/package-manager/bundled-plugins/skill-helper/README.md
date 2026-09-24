# Agnes Skill Helper

Official bundled plugin. New local profiles and existing profiles adopting default helpers install, trust and enable missing shipped helpers once, offline. Already installed packages retain their version, trust and enablement state. Later starts and upgrades preserve user disable/removal choices. Removing this helper does not delete resources it previously connected.

Imports local Skill directories, public GitHub repositories/subdirectories, HTTPS raw Markdown/JSON manifests and local ZIP files. Creates new Skill files from model output with optional official skill-creator guidance. Installation supports workspace/user scope, install-only, status and cancellation. GitHub imports and downloading creator guidance require network access; local directory/ZIP imports do not.

No private repository login, arbitrary webpage scraping or RAR/7z/tar. Remote ZIP files must be downloaded locally first. Existing differing contents are never overwritten. Approvals, filesystem rules and resource registration remain controlled by Agnes. Previously installed personal packages are not silently migrated or removed.

On GitHub API rate limits, public repository imports use a pinned commit archive with the same bounded public network policy and ZIP validation. Archives above the 2 MiB public-fetch limit still require local ZIP import. Existing installed helper packages are not automatically upgraded; update the installed package to receive this fix.

The four tools are skill_helper_import, skill_helper_creator, skill_helper_create and skill_helper_install. ready takes effect next turn; prepared/running are not success. Installation does not execute third-party scripts. Removing the helper does not delete already installed skills.

MIT license retained in LICENSE. Runtime implementation is vendored from the locally developed Skill Helper and maintained here with Agnes.
