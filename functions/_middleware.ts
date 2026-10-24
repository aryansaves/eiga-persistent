import type { Env } from '../src/config.ts';

export const onRequest: PagesFunction<Env> = async (context) => {
  const original = await context.next();
  const response = new Response(original.body, original);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (context.env.APP_ENV === 'staging' || new URL(context.request.url).searchParams.has('share')) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
};
