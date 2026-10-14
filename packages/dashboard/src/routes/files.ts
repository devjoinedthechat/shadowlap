import { closeSync, createReadStream } from 'node:fs';
import type { RouteContext } from '../context.js';
import { attachmentHeaders } from '../http.js';
import type { Router } from '../router.js';

/**
 * Files jobs wrote: `GET /api/files/:fileId` downloads one a job reported (a dataset, an OTel
 * trace, a HAR), only while the dashboard remembers that job and only from inside the project
 * folder, always as an attachment. The session token is checked as for every API request, so the
 * browser fetches it with the header and saves the blob, as it does the HTML download.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/files/:fileId', (r) => {
    const file = ctx.jobs.openFile(r.params.fileId!);
    try {
      r.res.writeHead(200, attachmentHeaders(file.name, file.bytes));
    } catch (err) {
      closeSync(file.fd);
      throw err;
    }
    if (r.req.method === 'HEAD') {
      closeSync(file.fd);
      r.res.end();
      return;
    }
    const stream = createReadStream('', { fd: file.fd, start: 0, end: Math.max(0, file.bytes - 1), autoClose: true });
    stream.on('error', () => r.res.destroy());
    if (file.bytes === 0) {
      stream.destroy();
      r.res.end();
      return;
    }
    stream.pipe(r.res);
  });
}
