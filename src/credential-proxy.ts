/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Per-group credentials:
 *   ANTHROPIC_API_KEY_<folder> or CLAUDE_CODE_OAUTH_TOKEN_<folder> in .env
 *   override the default for that group. The container runner encodes the
 *   group folder in the placeholder (e.g. "placeholder:foobar") so the proxy
 *   can look up the right credential.
 */
import { createServer, type Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, type RequestOptions } from 'http';

import { readEnvByPrefix, readEnvFile } from './env.ts';
import { logger } from './logger.ts';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

function buildCredentialMap(
  prefix: string,
  defaultValue: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (defaultValue) map.set('placeholder', defaultValue);
  for (const [envKey, value] of Object.entries(readEnvByPrefix(prefix))) {
    const suffix = envKey.slice(prefix.length);
    if (suffix.startsWith('_') && suffix.length > 1) {
      map.set(`placeholder:${suffix.slice(1).toLowerCase()}`, value);
    }
  }
  return map;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const defaultOauth =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const apiKeyMap = buildCredentialMap(
    'ANTHROPIC_API_KEY',
    secrets.ANTHROPIC_API_KEY,
  );
  const oauthMap = buildCredentialMap('CLAUDE_CODE_OAUTH_TOKEN', defaultOauth);

  const perGroupKeys = [...apiKeyMap.keys(), ...oauthMap.keys()].filter(
    (k) => k !== 'placeholder',
  );
  if (perGroupKeys.length) {
    logger.info({ groups: perGroupKeys }, 'Per-group credentials loaded');
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Resolve per-group or default API key
        const sentKey = headers['x-api-key'] as string | undefined;
        if (sentKey?.startsWith('placeholder')) {
          const realKey = apiKeyMap.get(sentKey) || secrets.ANTHROPIC_API_KEY;
          delete headers['x-api-key'];
          if (realKey) headers['x-api-key'] = realKey;
        }

        // Resolve per-group or default OAuth token
        if (headers['authorization']) {
          const bearer = (headers['authorization'] as string).replace(
            /^Bearer\s+/i,
            '',
          );
          if (bearer.startsWith('placeholder')) {
            const realToken = oauthMap.get(bearer) || defaultOauth;
            delete headers['authorization'];
            if (realToken) headers['authorization'] = `Bearer ${realToken}`;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

function hasEnvSuffix(
  entries: Record<string, string>,
  prefix: string,
  folder: string,
): boolean {
  return Object.keys(entries).some(
    (k) =>
      k.length > prefix.length &&
      k[prefix.length] === '_' &&
      k.slice(prefix.length + 1).toLowerCase() === folder,
  );
}

/** Detect auth mode for a specific group, checking for per-group overrides. */
export function detectGroupAuthMode(groupFolder: string): {
  mode: AuthMode;
  hasGroupKey: boolean;
} {
  const folder = groupFolder.toLowerCase();
  const keys = readEnvByPrefix('ANTHROPIC_API_KEY');
  const oauthKeys = readEnvByPrefix('CLAUDE_CODE_OAUTH_TOKEN');
  if (hasEnvSuffix(keys, 'ANTHROPIC_API_KEY', folder))
    return { mode: 'api-key', hasGroupKey: true };
  if (hasEnvSuffix(oauthKeys, 'CLAUDE_CODE_OAUTH_TOKEN', folder))
    return { mode: 'oauth', hasGroupKey: true };
  return {
    mode: keys['ANTHROPIC_API_KEY'] ? 'api-key' : 'oauth',
    hasGroupKey: false,
  };
}
