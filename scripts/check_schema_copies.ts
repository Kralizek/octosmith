const pairs = [
  [
    "schemas/octosmith.schema.json",
    "packages/octosmith/configuration/schemas/octosmith.schema.json",
  ],
  [
    "schemas/template.schema.json",
    "packages/octosmith/configuration/schemas/template.schema.json",
  ],
] as const;

for (const [canonical, packaged] of pairs) {
  const [canonicalContent, packagedContent] = await Promise.all([
    Deno.readTextFile(canonical),
    Deno.readTextFile(packaged),
  ]);

  if (canonicalContent !== packagedContent) {
    console.error(
      `Schema copy is out of sync: ${packaged} must match ${canonical}`,
    );
    Deno.exit(1);
  }
}
