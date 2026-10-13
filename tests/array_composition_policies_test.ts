import { assertEquals } from "@std/assert";
import {
  arrayCompositionPolicies,
} from "../packages/octosmith/configuration/array_policies.ts";
import schema from "../schemas/resources/repository.schema.json" with {
  type: "json",
};

interface SchemaNode {
  readonly type?: string;
  readonly $ref?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
}

const repositorySchema = schema as unknown as
  & SchemaNode
  & { readonly $defs: Readonly<Record<string, SchemaNode>> };

function resolve(node: SchemaNode): SchemaNode {
  if (node.$ref === undefined) return node;

  const prefix = "#/$defs/";
  if (!node.$ref.startsWith(prefix)) {
    throw new Error("Unexpected repository schema reference: " + node.$ref);
  }

  const definition = repositorySchema.$defs[node.$ref.slice(prefix.length)];
  if (definition === undefined) {
    throw new Error("Unknown repository schema definition: " + node.$ref);
  }
  return resolve(definition);
}

function schemaNodeAt(path: string): SchemaNode {
  let current: SchemaNode = repositorySchema;
  for (const segment of path === "" ? [] : path.split(".")) {
    current = resolve(current);
    if (segment === "*") {
      if (current.type !== "array" || current.items === undefined) {
        throw new Error("Expected array item at " + path);
      }
      current = current.items;
      continue;
    }

    const schemaKey = segment.replace(
      /[A-Z]/g,
      (character) => "_" + character.toLowerCase(),
    );
    const next: SchemaNode | undefined = current.properties?.[schemaKey];
    if (next === undefined) {
      throw new Error("Unknown repository configuration array path: " + path);
    }
    current = next;
  }
  return resolve(current);
}

Deno.test("every primary repository collection has an explicit array composition policy", () => {
  // Do not descend through arrays. Nested arrays are intentionally optional:
  // they retain replacement semantics unless explicitly opted into merging.
  const surfaces = ["", "actions", "dependabot"];
  const missing = surfaces.flatMap((surface) => {
    const properties = schemaNodeAt(surface).properties ?? {};
    return Object.entries(properties)
      .filter(([, definition]) => resolve(definition).type === "array")
      .map(([field]) => {
        const name = field.replace(
          /_([a-z])/g,
          (_, letter: string) => letter.toUpperCase(),
        );
        return surface === "" ? name : surface + "." + name;
      });
  }).filter((path) => !(path in arrayCompositionPolicies)).sort();

  assertEquals(
    missing,
    [],
    "Review merge identity or replacement policy for new primary collections",
  );
});

Deno.test("every declared array composition policy refers to a schema array", () => {
  const invalid = Object.keys(arrayCompositionPolicies).filter((path) => {
    try {
      return schemaNodeAt(path).type !== "array";
    } catch {
      return true;
    }
  });
  assertEquals(invalid, []);
});

Deno.test("nested arrays without policies are intentionally allowed", () => {
  assertEquals(arrayCompositionPolicies["rulesets.*.bypassActors"], undefined);
  assertEquals(arrayCompositionPolicies["settings.topics"], undefined);
});
