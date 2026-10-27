/** Reject nonportable paths, traversal, and Git-internal aliases before delivery. */
export function assertManagedFilePath(path: string): void {
  if (
    !path ||
    [...path].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    /[\\:"*?<>|\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/.test(
      path,
    ) ||
    path.split("/").some((part) =>
      !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || part.toLowerCase() === ".git" ||
      /^git~[0-9]+$/i.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part)
    )
  ) {
    throw new Error("Invalid managed file path");
  }
}
