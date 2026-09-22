/** Describes GitHub query value. */
export type GitHubQueryValue = string | number | boolean | undefined;

/** Describes GitHub request options. */
export interface GitHubRequestOptions {
  readonly query?: Readonly<Record<string, GitHubQueryValue>>;
  readonly body?: unknown;
  readonly allowNotFound?: boolean;
}

/** Describes GitHub client. */
export interface GitHubClient {
  request<T>(
    method: string,
    path: string,
    options?: GitHubRequestOptions,
  ): Promise<T>;

  get<T>(
    path: string,
    query?: Readonly<Record<string, GitHubQueryValue>>,
  ): Promise<T>;
}

/** Describes GitHub response trace. */
export interface GitHubResponseTrace {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** Describes fetch GitHub client options. */
export interface FetchGitHubClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly trace?: (entry: GitHubResponseTrace) => void;
}

/** Describes fetch GitHub client. */
export class FetchGitHubClient implements GitHubClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #trace?: (entry: GitHubResponseTrace) => void;

  constructor(options: FetchGitHubClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.github.com";
    this.#apiVersion = options.apiVersion ?? "2026-03-10";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#trace = options.trace;
  }

  get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async request<T>(
    method: string,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<T> {
    const baseUrl = this.#baseUrl.endsWith("/")
      ? this.#baseUrl
      : this.#baseUrl + "/";
    const relativePath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(relativePath, baseUrl);

    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const response = await this.#fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + this.#token,
        "content-type": "application/json",
        "x-github-api-version": this.#apiVersion,
      },
      ...(options.body !== undefined && {
        body: JSON.stringify(options.body),
      }),
    });

    const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
    const tracePath = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || "/"
      : url.pathname;

    this.#trace?.({
      method,
      path: tracePath.startsWith("/") ? tracePath : "/" + tracePath,
      status: response.status,
    });

    if (response.status === 404 && options.allowNotFound) {
      return undefined as T;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        "GitHub API request failed: " + response.status + " " +
          response.statusText + (body ? " - " + body : ""),
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();

    return text ? JSON.parse(text) as T : undefined as T;
  }
}
