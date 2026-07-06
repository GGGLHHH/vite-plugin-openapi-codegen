import * as ts from "typescript";

import type { BodyContentType, NormalizedChannel, TypeAliasDefinition } from "./normalization.ts";

const AST_PRINTER = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
});

interface AstApiEntry {
  funcName: string;
  group: string;
  pathTypeExpr: string | null;
  strippedPath: string;
}

interface AstClientOperation {
  bodyChannel: NormalizedChannel;
  bodyContentType: BodyContentType | null;
  builderAlias: string;
  funcName: string;
  group: string;
  methodUpper: string;
  optionTypeName: string;
  pathChannel: NormalizedChannel;
  pathInvocationExpr: string;
  queryChannel: NormalizedChannel;
  requestFunction: string;
  responseTypeExpr: string | null;
  returnTypeExpr: string;
}

interface AstClientRenderModel {
  needsSearchParamsHelper: boolean;
  operations: AstClientOperation[];
}

interface AstHttpClientConfig {
  jsonFunction: string;
  module: string;
  omitKeys: string[];
  requestOptionsType: string;
  voidFunction: string;
}

interface AstAccessPolicyEntry {
  anyOf?: string[][];
  apiPath: string;
  funcName: string;
  kind: string;
  methodUpper: string;
  operationId: string;
  permissions: string[];
  strippedPath: string;
}

export function renderApiSource(
  entries: AstApiEntry[],
  generatedHeader: readonly string[],
): string {
  const statements: ts.Statement[] = [];
  const seenGroups = new Set<string>();

  for (const entry of entries) {
    const parameters =
      entry.pathTypeExpr == null
        ? []
        : [
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              ts.factory.createIdentifier("params"),
              undefined,
              createTypeNodeFromText(entry.pathTypeExpr),
            ),
          ];

    const declaration = ts.factory.createFunctionDeclaration(
      [createExportModifier()],
      undefined,
      ts.factory.createIdentifier(entry.funcName),
      undefined,
      parameters,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      ts.factory.createBlock(
        [
          ts.factory.createReturnStatement(
            entry.pathTypeExpr == null
              ? ts.factory.createStringLiteral(entry.strippedPath)
              : createPathExpression(entry.strippedPath),
          ),
        ],
        true,
      ),
    );

    statements.push(
      seenGroups.has(entry.group)
        ? declaration
        : createGeneratedBannerComment(declaration, capitalize(entry.group)),
    );
    seenGroups.add(entry.group);
  }

  const sourceStatements: ts.Statement[] = [];
  const apiTypeImports = collectApiTypeImports(entries.map((entry) => entry.pathTypeExpr));
  if (apiTypeImports.length > 0) {
    sourceStatements.push(createTypeOnlyImport(apiTypeImports, "./api-types"));
  }
  sourceStatements.push(...statements);

  return printGeneratedFile(sourceStatements, generatedHeader);
}

export function renderClientSource(
  model: AstClientRenderModel,
  generatedHeader: readonly string[],
  httpClient: AstHttpClientConfig,
): string {
  const statements: ts.Statement[] = [
    createTypeOnlyImport([httpClient.requestOptionsType], httpClient.module),
    createValueImport(
      [{ name: httpClient.jsonFunction }, { name: httpClient.voidFunction }],
      httpClient.module,
    ),
  ];

  const apiTypeImports = collectApiTypeImports(
    model.operations.flatMap((operation) => [
      operation.bodyChannel.typeRef?.sourceExpr,
      operation.pathChannel.typeRef?.sourceExpr,
      operation.queryChannel.typeRef?.sourceExpr,
      operation.responseTypeExpr,
      operation.returnTypeExpr,
    ]),
  );
  if (apiTypeImports.length > 0) {
    statements.push(createTypeOnlyImport(apiTypeImports, "./api-types"));
  }

  statements.push(
    createValueImport(
      model.operations.map((operation) => ({
        alias: operation.builderAlias,
        name: operation.funcName,
      })),
      "./api",
    ),
  );

  const runtimeTypeExpr =
    httpClient.omitKeys.length > 0
      ? `Omit<${httpClient.requestOptionsType}, ${httpClient.omitKeys.map((k) => `'${k}'`).join(" | ")}>`
      : httpClient.requestOptionsType;

  statements.push(
    ts.factory.createTypeAliasDeclaration(
      undefined,
      ts.factory.createIdentifier("RuntimeRequestOptions"),
      undefined,
      createTypeNodeFromText(runtimeTypeExpr),
    ),
  );

  if (model.needsSearchParamsHelper) {
    statements.push(createBuildSearchParamsFunction());
  }

  const seenGroups = new Set<string>();
  for (const operation of model.operations) {
    const optionsInterface = createClientOptionsDeclaration(operation);
    statements.push(
      seenGroups.has(operation.group)
        ? optionsInterface
        : createGeneratedBannerComment(optionsInterface, capitalize(operation.group)),
    );
    statements.push(createClientFunctionDeclaration(operation));
    seenGroups.add(operation.group);
  }

  return printGeneratedFile(statements, generatedHeader);
}

export function renderOperationTypeAliases(typeAliases: TypeAliasDefinition[]): string {
  if (typeAliases.length === 0) {
    return "";
  }

  return `${typeAliases
    .map((alias) => `export type ${alias.typeName} = ${alias.definitionExpr};`)
    .join("\n")}\n`;
}

export function renderAccessPoliciesSource(
  entries: AstAccessPolicyEntry[],
  generatedHeader: readonly string[],
): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    ...generatedHeader,
    "",
    'export type AccessPolicyKind = "authenticated" | "internal" | "public" | "permission";',
    "",
    "// Grant check: anyOf ? anyOf.some((group) => group.every(has)) : (permissions ?? []).every(has)",
    "export interface AccessPolicy {",
    "  kind: AccessPolicyKind;",
    "  /** All required (AND). Absent when `anyOf` is present. */",
    "  permissions?: readonly string[];",
    "  /** OR of AND-groups: any fully-held group grants access. */",
    "  anyOf?: readonly (readonly string[])[];",
    "}",
    "",
    "export interface OperationAccessPolicy extends AccessPolicy {",
    "  apiPath: string;",
    "  method: string;",
    "  operationId: string;",
    "  path: string;",
    "}",
    "",
    "export const accessPolicies = {",
  ];

  for (const entry of entries) {
    lines.push(`  ${entry.funcName}: {`);
    lines.push(`    apiPath: ${JSON.stringify(entry.apiPath)},`);
    lines.push(`    kind: ${JSON.stringify(entry.kind)},`);
    lines.push(`    method: ${JSON.stringify(entry.methodUpper)},`);
    lines.push(`    operationId: ${JSON.stringify(entry.operationId)},`);
    lines.push(`    path: ${JSON.stringify(entry.strippedPath)},`);
    if (entry.permissions.length > 0) {
      lines.push(
        `    permissions: [${entry.permissions
          .map((permission) => JSON.stringify(permission))
          .join(", ")}],`,
      );
    }
    if (entry.anyOf && entry.anyOf.length > 0) {
      lines.push(
        `    anyOf: [${entry.anyOf
          .map((group) => `[${group.map((permission) => JSON.stringify(permission)).join(", ")}]`)
          .join(", ")}],`,
      );
    }
    lines.push("  },");
  }

  lines.push(
    "} as const satisfies Record<string, OperationAccessPolicy>;",
    "",
    "export type AccessPolicyKey = keyof typeof accessPolicies;",
    "",
  );

  return `${lines.join("\n")}`;
}

function printGeneratedFile(
  statements: ts.Statement[],
  generatedHeader: readonly string[],
): string {
  const sourceFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  const printed = AST_PRINTER.printFile(sourceFile).trim();
  return printed.length > 0
    ? `${generatedHeader.join("\n")}\n\n${printed}\n`
    : `${generatedHeader.join("\n")}\n`;
}

function parseExpression(sourceText: string): ts.Expression {
  const sourceFile = ts.createSourceFile(
    "generated-expression.ts",
    `const value = ${sourceText}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error(`Failed to parse expression: ${sourceText}`);
  }

  const declaration = statement.declarationList.declarations[0];
  if (!declaration?.initializer) {
    throw new Error(`Missing parsed initializer for: ${sourceText}`);
  }

  return declaration.initializer;
}

function createTypeOnlyImport(names: string[], moduleSpecifier: string): ts.ImportDeclaration {
  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      true,
      undefined,
      ts.factory.createNamedImports(
        names.map((name) =>
          ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name)),
        ),
      ),
    ),
    ts.factory.createStringLiteral(moduleSpecifier),
  );
}

function createValueImport(
  specifiers: Array<{ alias?: string; name: string }>,
  moduleSpecifier: string,
): ts.ImportDeclaration {
  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      false,
      undefined,
      ts.factory.createNamedImports(
        specifiers.map((specifier) =>
          ts.factory.createImportSpecifier(
            false,
            specifier.alias ? ts.factory.createIdentifier(specifier.name) : undefined,
            ts.factory.createIdentifier(specifier.alias ?? specifier.name),
          ),
        ),
      ),
    ),
    ts.factory.createStringLiteral(moduleSpecifier),
  );
}

function createExportModifier(): ts.Modifier {
  return ts.factory.createModifier(ts.SyntaxKind.ExportKeyword);
}

function createGeneratedBannerComment<T extends ts.Node>(node: T, text: string): T {
  return ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.SingleLineCommentTrivia,
    ` ${text}`,
    true,
  );
}

function collectApiTypeImports(typeExprs: Array<string | null | undefined>): string[] {
  const names = new Set<string>();

  for (const typeExpr of typeExprs) {
    if (!typeExpr) {
      continue;
    }

    if (typeExpr.includes("components[")) {
      names.add("components");
    }
    if (typeExpr.includes("operations[")) {
      names.add("operations");
      continue;
    }

    const name = typeExpr.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !isBuiltinTypeName(name)) {
      names.add(name);
    }
  }

  return [...names].sort();
}

function isBuiltinTypeName(name: string): boolean {
  return new Set([
    "AbortSignal",
    "Array",
    "Blob",
    "Date",
    "Error",
    "File",
    "FormData",
    "Map",
    "Omit",
    "Promise",
    "Record",
    "Set",
    "URLSearchParams",
    "boolean",
    "never",
    "null",
    "number",
    "object",
    "string",
    "undefined",
    "unknown",
    "void",
  ]).has(name);
}

function createPathExpression(strippedPath: string): ts.Expression {
  const matches = [...strippedPath.matchAll(/\{(\w+)\}/g)];
  if (matches.length === 0) {
    return ts.factory.createStringLiteral(strippedPath);
  }

  const [firstMatch] = matches;
  const spans = matches.map((match, index) => {
    const nextMatch = matches[index + 1];
    const literalText = strippedPath.slice(
      match.index! + match[0].length,
      nextMatch?.index ?? strippedPath.length,
    );

    return ts.factory.createTemplateSpan(
      ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("params"), match[1]),
      nextMatch
        ? ts.factory.createTemplateMiddle(literalText)
        : ts.factory.createTemplateTail(literalText),
    );
  });

  return ts.factory.createTemplateExpression(
    ts.factory.createTemplateHead(strippedPath.slice(0, firstMatch.index)),
    spans,
  );
}

function createTypeNodeFromText(sourceText: string): ts.TypeNode {
  const sf = ts.createSourceFile(
    "__type__.ts",
    `type __T__ = ${sourceText}`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) {
    throw new Error(`Failed to parse type expression: ${sourceText}`);
  }
  return stmt.type;
}

function createClientOptionsDeclaration(operation: AstClientOperation): ts.InterfaceDeclaration {
  return ts.factory.createInterfaceDeclaration(
    [createExportModifier()],
    ts.factory.createIdentifier(operation.optionTypeName),
    undefined,
    undefined,
    [
      createClientChannelField("query", operation.queryChannel),
      createClientChannelField("path", operation.pathChannel),
      createClientChannelField("body", operation.bodyChannel),
      ts.factory.createPropertySignature(
        undefined,
        ts.factory.createIdentifier("signal"),
        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        ts.factory.createTypeReferenceNode("AbortSignal"),
      ),
    ],
  );
}

function createClientChannelField(
  key: "body" | "path" | "query",
  channel: NormalizedChannel,
): ts.PropertySignature {
  return ts.factory.createPropertySignature(
    undefined,
    ts.factory.createIdentifier(key),
    channel.present && channel.required
      ? undefined
      : ts.factory.createToken(ts.SyntaxKind.QuestionToken),
    channel.present && channel.typeRef
      ? createTypeNodeFromText(channel.typeRef.sourceExpr)
      : ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
  );
}

function createClientFunctionDeclaration(operation: AstClientOperation): ts.FunctionDeclaration {
  const requestProperties: ts.ObjectLiteralElementLike[] = [
    ts.factory.createSpreadAssignment(ts.factory.createIdentifier("requestOptions")),
    ts.factory.createPropertyAssignment(
      ts.factory.createIdentifier("method"),
      ts.factory.createStringLiteral(operation.methodUpper),
    ),
  ];

  if (operation.queryChannel.present) {
    requestProperties.push(
      ts.factory.createPropertyAssignment(
        ts.factory.createIdentifier("searchParams"),
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("buildSearchParams"),
          undefined,
          [
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("options"),
              "query",
            ),
          ],
        ),
      ),
    );
  }

  if (operation.bodyChannel.present) {
    const bodyPropertyName = operation.bodyContentType === "json" ? "json" : "body";
    const bodyAssignment = ts.factory.createObjectLiteralExpression(
      [
        ts.factory.createPropertyAssignment(
          ts.factory.createIdentifier(bodyPropertyName),
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("options"), "body"),
        ),
      ],
      false,
    );

    if (operation.bodyContentType === "json") {
      requestProperties.push(createBodyRequestProperty(operation.bodyChannel, bodyAssignment));
    } else {
      requestProperties.push(createBodyRequestProperty(operation.bodyChannel, bodyAssignment));
    }

    if (operation.bodyContentType === "binary") {
      requestProperties.push(
        ts.factory.createPropertyAssignment(
          ts.factory.createIdentifier("contentType"),
          ts.factory.createStringLiteral("application/octet-stream"),
        ),
      );
    }
  }

  requestProperties.push(
    ts.factory.createPropertyAssignment(
      ts.factory.createIdentifier("signal"),
      ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("options"), "signal"),
    ),
  );

  const requestCall = ts.factory.createCallExpression(
    ts.factory.createIdentifier(operation.requestFunction),
    operation.responseTypeExpr ? [createTypeNodeFromText(operation.responseTypeExpr)] : undefined,
    [
      parseExpression(operation.pathInvocationExpr),
      ts.factory.createObjectLiteralExpression(requestProperties, true),
    ],
  );

  return ts.factory.createFunctionDeclaration(
    [createExportModifier()],
    undefined,
    ts.factory.createIdentifier(operation.funcName),
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        ts.factory.createIdentifier("options"),
        undefined,
        ts.factory.createTypeReferenceNode(operation.optionTypeName),
      ),
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        ts.factory.createIdentifier("requestOptions"),
        undefined,
        ts.factory.createTypeReferenceNode("RuntimeRequestOptions"),
        ts.factory.createObjectLiteralExpression(),
      ),
    ],
    createTypeNodeFromText(operation.returnTypeExpr),
    ts.factory.createBlock([ts.factory.createReturnStatement(requestCall)], true),
  );
}

function createBodyRequestProperty(
  bodyChannel: NormalizedChannel,
  bodyAssignment: ts.ObjectLiteralExpression,
): ts.ObjectLiteralElementLike {
  if (bodyChannel.required) {
    return bodyAssignment.properties[0];
  }

  return ts.factory.createSpreadAssignment(
    ts.factory.createParenthesizedExpression(
      ts.factory.createConditionalExpression(
        ts.factory.createBinaryExpression(
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("options"), "body"),
          ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          ts.factory.createIdentifier("undefined"),
        ),
        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        ts.factory.createObjectLiteralExpression([], false),
        ts.factory.createToken(ts.SyntaxKind.ColonToken),
        bodyAssignment,
      ),
    ),
  );
}

function createBuildSearchParamsFunction(): ts.FunctionDeclaration {
  const queryIdentifier = ts.factory.createIdentifier("query");
  const searchParamsIdentifier = ts.factory.createIdentifier("searchParams");
  const hasParamsIdentifier = ts.factory.createIdentifier("hasParams");
  const keyIdentifier = ts.factory.createIdentifier("key");
  const valueIdentifier = ts.factory.createIdentifier("value");
  const itemIdentifier = ts.factory.createIdentifier("item");

  // Omit only absent params (null/undefined). An empty string is a real value
  // the API contract owns — e.g. an empty `cursor` seeds the first keyset page —
  // so the client must not collapse "" into "absent". Callers signal "no param"
  // by passing undefined.
  const isNullish = (identifier: ts.Identifier) =>
    ts.factory.createBinaryExpression(
      identifier,
      ts.factory.createToken(ts.SyntaxKind.EqualsEqualsToken),
      ts.factory.createNull(),
    );

  const assignHasParamsTrue = () =>
    ts.factory.createExpressionStatement(
      ts.factory.createAssignment(hasParamsIdentifier, ts.factory.createTrue()),
    );

  return ts.factory.createFunctionDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier("buildSearchParams"),
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        queryIdentifier,
        undefined,
        createTypeNodeFromText("Record<string, unknown> | undefined"),
      ),
    ],
    createTypeNodeFromText("URLSearchParams | undefined"),
    ts.factory.createBlock(
      [
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            queryIdentifier,
            ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            ts.factory.createIdentifier("undefined"),
          ),
          ts.factory.createReturnStatement(ts.factory.createIdentifier("undefined")),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                searchParamsIdentifier,
                undefined,
                undefined,
                ts.factory.createNewExpression(
                  ts.factory.createIdentifier("URLSearchParams"),
                  undefined,
                  [],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                hasParamsIdentifier,
                undefined,
                undefined,
                ts.factory.createFalse(),
              ),
            ],
            ts.NodeFlags.Let,
          ),
        ),
        ts.factory.createForOfStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                ts.factory.createArrayBindingPattern([
                  ts.factory.createBindingElement(undefined, undefined, keyIdentifier),
                  ts.factory.createBindingElement(undefined, undefined, valueIdentifier),
                ]),
              ),
            ],
            ts.NodeFlags.Const,
          ),
          parseExpression("Object.entries(query)"),
          ts.factory.createBlock(
            [
              ts.factory.createIfStatement(
                isNullish(valueIdentifier),
                ts.factory.createContinueStatement(),
              ),
              ts.factory.createIfStatement(
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier("Array"),
                    "isArray",
                  ),
                  undefined,
                  [valueIdentifier],
                ),
                ts.factory.createBlock(
                  [
                    ts.factory.createForOfStatement(
                      undefined,
                      ts.factory.createVariableDeclarationList(
                        [ts.factory.createVariableDeclaration(itemIdentifier)],
                        ts.NodeFlags.Const,
                      ),
                      valueIdentifier,
                      ts.factory.createBlock(
                        [
                          ts.factory.createIfStatement(
                            isNullish(itemIdentifier),
                            ts.factory.createContinueStatement(),
                          ),
                          ts.factory.createExpressionStatement(
                            ts.factory.createCallExpression(
                              ts.factory.createPropertyAccessExpression(
                                searchParamsIdentifier,
                                "append",
                              ),
                              undefined,
                              [
                                keyIdentifier,
                                ts.factory.createCallExpression(
                                  ts.factory.createIdentifier("String"),
                                  undefined,
                                  [itemIdentifier],
                                ),
                              ],
                            ),
                          ),
                          assignHasParamsTrue(),
                        ],
                        true,
                      ),
                    ),
                    ts.factory.createContinueStatement(),
                  ],
                  true,
                ),
              ),
              ts.factory.createExpressionStatement(
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(searchParamsIdentifier, "set"),
                  undefined,
                  [
                    keyIdentifier,
                    ts.factory.createCallExpression(
                      ts.factory.createIdentifier("String"),
                      undefined,
                      [valueIdentifier],
                    ),
                  ],
                ),
              ),
              assignHasParamsTrue(),
            ],
            true,
          ),
        ),
        ts.factory.createReturnStatement(
          ts.factory.createConditionalExpression(
            hasParamsIdentifier,
            ts.factory.createToken(ts.SyntaxKind.QuestionToken),
            searchParamsIdentifier,
            ts.factory.createToken(ts.SyntaxKind.ColonToken),
            ts.factory.createIdentifier("undefined"),
          ),
        ),
      ],
      true,
    ),
  );
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
