import { handle, type R2BucketLike } from './handler.ts';

export default {
  fetch: (request: Request, env: { FILES: R2BucketLike }): Promise<Response> => handle(request, env.FILES),
};
