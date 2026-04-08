import * as ts from "typescript";

import type { NormalizedChannel } from "./normalization.ts";

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
  typeImports: string[];
}

interface AstHttpClientConfig {
  jsonFunction: string;
  module: string;
  omitKeys: string[];
  requestOptionsType: string;
  voidFunction: string;
}

export function renderTypesSource(
  schemaNames: string[],
  legacyAliases: Record<string, string> | undefined,
  generatedHeader: readonly string[],
): string {
  const statements: ts.Statement[] = [createTypeOnlyImport(["components"], "./api-types")];

  for (const name of schemaNames) {
    statements.push(
      ts.factory.createTypeAliasDeclaration(
        [createExportModifier()],
        ts.factory.createIdentifier(name),
        undefined,
        createIndexedAccessTypeNode("components", ["schemas", name]),
      ),
    );
  }

  if (legacyAliases && Object.keys(legacyAliases).length > 0) {
    const aliases = Object.entries(legacyAliases);
    aliases.forEach(([alias, target], index) => {
      const statement = ts.factory.createTypeAliasDeclaration(
        [createExportModifier()],
        ts.factory.createIdentifier(alias),
        undefined,
        createTypeNodeFromText(target),
      );
      statements.push(
        index === 0 ? createGeneratedBannerComment(statement, "Legacy aliases") : statement,
      );
    });
  }

  return printGeneratedFile(statements, generatedHeader);
}

export function renderApiSource(
  entries: AstApiEntry[],
  generatedHeader: readonly string[],
): string {
  const statements: ts.Statement[] = [];
  const seenGroups = new Set<string>();
  let needsOperationsImport = false;
  const typeAliasImports = new Set<string>();

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

    if (entry.pathTypeExpr) {
      if (entry.pathTypeExpr.includes("operations[")) {
        needsOperationsImport = true;
      } else if (/^[A-Z]\w*$/.test(entry.pathTypeExpr)) {
        typeAliasImports.add(entry.pathTypeExpr);
      }
    }

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
  if (needsOperationsImport) {
    sourceStatements.push(createTypeOnlyImport(["operations"], "./api-types"));
  }
  if (typeAliasImports.size > 0) {
    sourceStatements.push(createTypeOnlyImport([...typeAliasImports].sort(), "./types"));
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
    createTypeOnlyImport(["operations"], "./api-types"),
  ];

  if (model.typeImports.length > 0) {
    statements.push(createTypeOnlyImport(model.typeImports, "./types"));
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

function createStringLiteralType(value: string): ts.LiteralTypeNode {
  return ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(value));
}

function createIndexedAccessTypeNode(rootName: string, indices: string[]): ts.TypeNode {
  let current: ts.TypeNode = ts.factory.createTypeReferenceNode(rootName);

  for (const index of indices) {
    current = ts.factory.createIndexedAccessTypeNode(current, createStringLiteralType(index));
  }

  return current;
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
    channel.present && channel.typeExpr
      ? createTypeNodeFromText(channel.typeExpr)
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
    requestProperties.push(
      ts.factory.createPropertyAssignment(
        ts.factory.createIdentifier("json"),
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("options"), "body"),
      ),
    );
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

function createBuildSearchParamsFunction(): ts.FunctionDeclaration {
  return ts.factory.createFunctionDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier("buildSearchParams"),
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        ts.factory.createIdentifier("query"),
        undefined,
        createTypeNodeFromText("Record<string, unknown> | undefined"),
      ),
    ],
    createTypeNodeFromText("URLSearchParams | undefined"),
    ts.factory.createBlock(
      [
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createIdentifier("query"),
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
                ts.factory.createIdentifier("entries"),
                undefined,
                undefined,
                parseExpression("Object.entries(query).filter(([, value]) => value != null)"),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("entries"),
              "length",
            ),
            ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            ts.factory.createNumericLiteral("0"),
          ),
          ts.factory.createReturnStatement(ts.factory.createIdentifier("undefined")),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                ts.factory.createIdentifier("searchParams"),
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
        ts.factory.createForOfStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                ts.factory.createArrayBindingPattern([
                  ts.factory.createBindingElement(undefined, undefined, "key"),
                  ts.factory.createBindingElement(undefined, undefined, "value"),
                ]),
              ),
            ],
            ts.NodeFlags.Const,
          ),
          ts.factory.createIdentifier("entries"),
          ts.factory.createBlock(
            [
              ts.factory.createExpressionStatement(
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier("searchParams"),
                    "set",
                  ),
                  undefined,
                  [
                    ts.factory.createIdentifier("key"),
                    ts.factory.createCallExpression(
                      ts.factory.createIdentifier("String"),
                      undefined,
                      [ts.factory.createIdentifier("value")],
                    ),
                  ],
                ),
              ),
            ],
            true,
          ),
        ),
        ts.factory.createReturnStatement(ts.factory.createIdentifier("searchParams")),
      ],
      true,
    ),
  );
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
