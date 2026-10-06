import ky from 'ky';
import { $t } from '../shared';
import { ensure, formatDate, NodeError } from '../utils';

/**
 * Nexus Mods access layer.
 *
 * Historically this used two undocumented endpoints: `https://api.nexusmods.com/mods`
 * for the keyword search and a Cheerio scrape of `www.nexusmods.com/<game>/mods/<id>`
 * for the module page. Both are gone - the former answers `404`, the latter is behind
 * Cloudflare and answers `403` for any non-browser client.
 *
 * Everything now goes through the official `v2` GraphQL API
 * (`https://api.nexusmods.com/v2/graphql`), which requires a personal API key read
 * from the `NEXUS_API_KEY` environment variable.
 *
 * Notes on the schema this file depends on:
 *   - `mods(filter:, sort:, count:, offset:)` returns `ModPage { totalCount nodes }`
 *   - `ModsFilter.name`/`gameDomainName`/`modId` accept `[{ value, op }]` pairs
 *   - `filter.modId` is rejected unless `filter.gameId` is present as well
 *   - the only way to sort search results is `sort: [{ relevance: { direction } }]`
 */

/* eslint-disable @typescript-eslint/naming-convention */
const NEXUS_MODS_GAME_DOMAIN = 'mountandblade2bannerlord';
/** Game ID of `Mount and Blade II: Bannerlord`. */
const NEXUS_MODS_GAME_ID = 3174;
const NEXUS_MODS_BASE_URL = 'https://www.nexusmods.com/';
const NEXUS_MODS_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';
const NEXUS_MODS_API_KEY_URL = 'https://www.nexusmods.com/users/myaccount?tab=api';
const MAX_RESULT_COUNT = 60;
/* eslint-enable @typescript-eslint/naming-convention */

interface UploaderOptions {
    memberId?: number;
    name?: string;
}

interface TagOptions {
    name?: string;
}

interface NexusmodRecordOptions {
    modId: number;
    name: string;
    summary?: string;
    version?: string;
    author?: string;
    downloads?: number;
    endorsements?: number;
    adultContent?: boolean;
    createdAt?: string;
    updatedAt?: string;
    pictureUrl?: string;
    thumbnailUrl?: string;
    description?: string;
    category?: string;
    status?: string;
    uploader?: UploaderOptions;
    tags?: TagOptions[];
}

interface ModPageResponseOptions {
    mods?: {
        totalCount?: number;
        nodes?: NexusmodRecordOptions[];
    };
}

type GraphqlPayloadOptions<T> = {
    data?: T;
    errors?: Array<{ message?: string }>;
};

const MOD_FIELDS = `
    modId
    name
    summary
    version
    author
    downloads
    endorsements
    adultContent
    createdAt
    updatedAt
    pictureUrl
    thumbnailUrl
    uploader {
        memberId
        name
    }`;

const SEARCH_DOCUMENT = `
query SearchModules($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
    mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
        totalCount
        nodes {${MOD_FIELDS}
        }
    }
}`;

const DETAIL_DOCUMENT = `
query ModuleDetail($filter: ModsFilter) {
    mods(filter: $filter, count: 1) {
        totalCount
        nodes {${MOD_FIELDS}
            description
            category
            status
            tags {
                name
            }
        }
    }
}`;

/* eslint-disable @typescript-eslint/naming-convention */
const HTML_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': ' ',
};
/* eslint-enable @typescript-eslint/naming-convention */

function truncate(text: string, length = 300): string {
    return text.length > length ? `${text.slice(0, length)}...` : text;
}

/**
 * Nexus module descriptions are BBCode flavoured markup. The renderers expect either
 * readable text (`description`) or HTML (`htmlContent`), so flatten it down once and
 * reuse the result for both.
 */
function bbcodeToText(bbcode: string): string {
    return bbcode
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\[img\][\S\s]*?\[\/img\]/gi, '')
        .replace(/\[url=([^\]]+)\]([\S\s]*?)\[\/url\]/gi, '$2 ($1)')
        .replace(/\[url\]([\S\s]*?)\[\/url\]/gi, '$1')
        .replace(/\[[^[\]]*\]/g, '')
        .replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getApiKey(): string {
    const apiKey = (process.env.NEXUS_API_KEY ?? process.env.NEXUSMODS_API_KEY ?? '').trim();
    ensure(
        apiKey,
        `A Nexus Mods personal API key is required. Create one at ${NEXUS_MODS_API_KEY_URL} and expose it as the NEXUS_API_KEY environment variable (it is also read from the MCP server \`env\` block).`,
        'EINVAL_NEXUSMOD_API_KEY',
    );

    return apiKey;
}

async function query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    const response = await ky.post(NEXUS_MODS_GRAPHQL_URL, {
        headers: { apikey: getApiKey(), 'User-Agent': 'BannerlordHelper/1.0 (local)' },
        json: { query: document, variables },
        timeout: 30_000,
        throwHttpErrors: false,
    });

    const body = await response.text();
    ensure(
        response.ok,
        `Nexus Mods API request failed (HTTP ${response.status}): ${truncate(body)}`,
        'EINVAL_NEXUSMOD_RESPONSE',
    );

    let payload: GraphqlPayloadOptions<T>;
    try {
        payload = JSON.parse(body) as GraphqlPayloadOptions<T>;
    } catch {
        throw new NodeError(
            `Nexus Mods API returned a non-JSON payload: ${truncate(body)}`,
            'EINVAL_NEXUSMOD_RESPONSE',
        );
    }

    const errors = payload.errors ?? [];
    ensure(
        errors.length === 0,
        `Nexus Mods API rejected the query: ${errors.map((error) => error.message ?? 'unknown').join('; ')}`,
        'EINVAL_NEXUSMOD_RESPONSE',
    );

    ensure(payload.data, 'Nexus Mods API returned an empty payload.', 'EINVAL_NEXUSMOD_RESPONSE');

    return payload.data;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const nexusmodOptionVO = (option: NexusmodRecordOptions) => ({
    id: option.modId,
    name: option.name,
    author: {
        id: option.uploader?.memberId,
        name: option.author ?? option.uploader?.name,
    },
    url: new URL(`/${NEXUS_MODS_GAME_DOMAIN}/mods/${option.modId}`, NEXUS_MODS_BASE_URL).href,
    thumbnail: option.thumbnailUrl ?? option.pictureUrl ?? '',
    downloads: `${option.downloads ?? 0}`,
    endorsements: `${option.endorsements ?? 0}`,
    isAdult: Boolean(option.adultContent),
    version: option.version,
    summary: option.summary,
});

export type NexusmodModuleOptions = ReturnType<typeof nexusmodOptionVO>;

export interface GetModulesOptions {
    /** Maximum amount of results requested from the API (1-60). */
    count?: number;
    /** Result offset, useful for paging. */
    offset?: number;
}

/**
 * Searches Nexus Mods for Bannerlord modules.
 *
 * @param {string | string[]} keywords Search keywords, a phrase is matched as a whole.
 * @param {GetModulesOptions} [options] Paging options.
 * @return {Promise<NexusmodModuleOptions[]>} The matching modules.
 */
export async function getModules(
    keywords: string | string[],
    options: GetModulesOptions = {},
): Promise<NexusmodModuleOptions[]> {
    const keyword = (Array.isArray(keywords) ? keywords.join(' ') : keywords ?? '').trim();
    ensure(keyword, $t('EINVAL_MISSING_KEYWORDS'), 'EINVAL_MISSING_KEYWORDS');

    const count = Math.min(Math.max(options.count ?? MAX_RESULT_COUNT, 1), MAX_RESULT_COUNT);
    const offset = Math.max(options.offset ?? 0, 0);

    // Keyword search is modelled as a widening wildcard match on the module name.
    const data = await query<ModPageResponseOptions>(SEARCH_DOCUMENT, {
        filter: {
            gameDomainName: [{ value: NEXUS_MODS_GAME_DOMAIN, op: 'EQUALS' }],
            name: [{ value: keyword, op: 'WILDCARD' }],
        },
        sort: [{ relevance: { direction: 'DESC' } }],
        count,
        offset,
    });

    return (data.mods?.nodes ?? []).map((item) => nexusmodOptionVO(item));
}

export type ModulePageOptions = ReturnType<typeof modulePageOptionVO>;

// eslint-disable-next-line @typescript-eslint/naming-convention
function modulePageOptionVO(node: NexusmodRecordOptions) {
    const description = node.description ? bbcodeToText(node.description) : undefined;
    const gallery = [node.pictureUrl, node.thumbnailUrl].filter((item): item is string => Boolean(item));

    return {
        title: node.name,
        endorsements: `${node.endorsements ?? 0}`,
        // The GraphQL API only exposes the combined download counter.
        uniqueDownloads: undefined as string | undefined,
        totalDownloads: `${node.downloads ?? 0}`,
        totalViews: undefined as string | undefined,
        remoteVersion: node.version,
        gallery,
        lastUpdated: node.updatedAt ? formatDate(node.updatedAt) : undefined,
        originalUpload: node.createdAt ? formatDate(node.createdAt) : undefined,
        createdBy: node.author ?? node.uploader?.name,
        uploadedBy: node.uploader?.name,
        // Virus scan verdicts are only rendered on the website, not exposed by the API.
        virusScan: undefined as string | undefined,
        tags: (node.tags ?? [])
            .map((tag) => tag.name)
            .filter((item): item is string => Boolean(item)),
        description,
        htmlContent: description ?? '',
    };
}

/**
 * Fetches the Nexus Mods metadata of a single module.
 *
 * @param {string | number} id The Nexus Mods module id.
 * @return {Promise<ModulePageOptions>} The module metadata.
 */
export async function getModulePage(id: string | number): Promise<ModulePageOptions> {
    const modId = `${id}`.trim();
    ensure(modId, 'A Nexus Mods module id is required.', 'EINVAL_MISSING_KEYWORDS');
    ensure(
        /^\d+$/.test(modId),
        `Invalid Nexus Mods module id "${modId}", a numeric id is expected.`,
        'EINVAL_NEXUSMOD_RESPONSE',
    );

    const data = await query<ModPageResponseOptions>(DETAIL_DOCUMENT, {
        // `modId` filtering is only accepted together with a `gameId`.
        filter: {
            gameId: [{ value: `${NEXUS_MODS_GAME_ID}`, op: 'EQUALS' }],
            modId: [{ value: modId, op: 'EQUALS' }],
        },
    });

    const node = data.mods?.nodes?.[0];
    ensure(
        node,
        `No Nexus Mods entry found for module id ${modId}.`,
        'EINVAL_NEXUSMOD_RESPONSE',
    );

    return modulePageOptionVO(node);
}
