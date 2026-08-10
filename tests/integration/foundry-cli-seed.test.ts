import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { createInitialStateSessionCreateFetch, createSessionWithInitialState } from '../../src/cli.js';
import { startRouteHarness } from './foundry-test-utils.js';

function effect(name: string, payload: Record<string, unknown>) {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: 'widget_output',
        payload,
      },
    ],
  };
}

describe('foundry CLI initial state seed', () => {
  it('rewrites REPL session creation so CLI seeds become an initial trigger', async () => {
    const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      const body = await readJson(request);
      requests.push({
        method: request.method,
        path: url.pathname,
        auth: request.headers.get('authorization'),
        body,
      });

      if (request.method === 'POST' && url.pathname === '/sessions') {
        return json({ sessionId: 'session-1' }, 201);
      }
      return json({ error: 'not found' }, 404);
    };

    const seededFetch = createInitialStateSessionCreateFetch(fakeFetch, {
      'program.slug': 'foo',
      'program.name': 'Foo',
      'program.target_dir': '/tmp/foo',
    });

    await seededFetch(new Request('http://pgas.test/sessions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        program: 'pgas-new',
        initial_trigger: {
          channel: 'seed',
          payload: {
            'inputs.domain_context.query': 'Create Foo.',
          },
        },
      }),
    }));

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/sessions',
        auth: 'Bearer dev-token',
        body: {
          program: 'pgas-new',
          initial_trigger: {
            channel: 'seed',
            payload: {
              'program.slug': 'foo',
              'program.name': 'Foo',
              'program.target_dir': '/tmp/foo',
              'program.target_dir_confirmed': true,
              'inputs.domain_context.query': 'Create Foo.',
            },
          },
        },
      },
    ]);
  });

  it('routes slug/name/target_dir seeds through a governed create-time round', async () => {
    const authorActions: string[] = [];
    const { client, close } = await startRouteHarness({
      programs: [{ name: 'pgas-new', entry: createPgasNewFoundryProgramEntry() }],
      authorHandle: {
        modelId: 'pgas-new-cli-seed-test',
        async complete() {
          authorActions.push('choose_design_path');
          return JSON.stringify(effect('choose_design_path', { choice: 'default' }));
        },
      },
      observerModelId: 'pgas-new-cli-seed-observer',
    });

    try {
      const created = await createSessionWithInitialState(client, {
        program: 'pgas-new',
        initialState: {
          'program.slug': 'foo',
          'program.name': 'Foo',
          'program.target_dir': '/tmp/foo',
        },
        domainContext: { query: 'Create Foo.' },
      });

      const seededWorld = await client.sessions.world(created.sessionId);
      expect(seededWorld.domain['program.slug']).toBe('foo');
      expect(seededWorld.domain['program.name']).toBe('Foo');
      expect(seededWorld.domain['program.target_dir']).toBe('/tmp/foo');
      expect(seededWorld.domain['program.target_dir_confirmed']).toBe(true);
      expect(seededWorld.domain['inputs.domain_context.query']).toBe('Create Foo.');
      expect(authorActions).toEqual(['choose_design_path']);
    } finally {
      await close();
    }
  });
});

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
