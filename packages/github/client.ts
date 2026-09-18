export type GitHubQueryValue = string | number | boolean | undefined;

export interface GitHubClient {
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

  async get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    const url = new URL(path, this.#baseUrl);

    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const response = await this.#fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + this.#token,
        "x-github-api-version": this.#apiVersion,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        "GitHub API request failed: " + response.status + " " +
          response.statusText + (body ? " - " + body : ""),
      );
    }

    return await response.json() as T;
  }
}
