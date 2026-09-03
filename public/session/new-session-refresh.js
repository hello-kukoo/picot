// ABOUTME: Decides whether a prompt needs sidebar discovery for a new Pi session.
// ABOUTME: Distinguishes a missing persisted session file from a collapsed sidebar list.

export function shouldRefreshSidebarForNewSession({ mirrorActiveSessionFile } = {}) {
  // Pi supplies the persisted JSONL path for every existing session. Only a
  // fresh runtime lacks it before the first prompt is written to disk.
  return !mirrorActiveSessionFile;
}
