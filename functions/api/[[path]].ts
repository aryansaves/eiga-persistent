import { handle } from '../../src/app.ts';
import type { Env } from '../../src/config.ts';

export const onRequest: PagesFunction<Env> = (context) => handle(context.request, context.env);
