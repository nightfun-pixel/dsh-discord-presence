/**
 * The machine-readable twin of the presence card.
 *
 * Discord shows the card to a human; this file is what anything else can read —
 * a bot, a stream overlay, a shell prompt, a script that wants to know how many
 * tokens the harness has eaten. It is written atomically (temp file plus rename)
 * so a reader never sees a half-written document.
 *
 * @module discord-presence/lib/status-file
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Where the status file lives by default.
 * @returns {string} `<DSH_HOME>/discord-presence/status.json`.
 */
export function defaultStatusPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'discord-presence', 'status.json');
}

/**
 * Write the status document.
 *
 * @param {string} file - absolute target path.
 * @param {object} payload - the JSON-serializable document.
 * @returns {{ ok: true, path: string } | { ok: false, error: string }} the outcome, never a throw.
 */
export function writeStatusFile(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
