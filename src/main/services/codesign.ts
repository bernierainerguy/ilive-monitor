import { execFile } from 'node:child_process';

/** Team ID a file is code-signed with (codesign prints it on stderr), or null if unsigned / unreadable. */
export function signingTeam(path: string, run: typeof execFile = execFile): Promise<string | null> {
  return new Promise((resolve) => {
    run('codesign', ['-dv', '--verbose=2', path], (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = /TeamIdentifier=([A-Z0-9]+)/.exec(`${stdout}\n${stderr}`);
      resolve(m && m[1] !== 'not' ? m[1]! : null);
    });
  });
}
