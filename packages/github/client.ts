export type GitHubQueryValue = string | number | boolean | undefined;

export interface GitHubRequestOptions {
  readonly query?: Readonly<Record<string, GitHubQueryValue>>;
  readonly body?: unknown;
  readonly allowNotFound?: boolean;
}

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

export interface FetchGitHubClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class FetchGitHubClient implements GitHubClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FetchGitHubClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.github.com";
    this.#apiVersion = options.apiVersion ?? "2026-03-10";
    this.#fetch = options.fetch ?? globalThis.fetch;
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
    const url = new URL(path, this.#baseUrl);

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
