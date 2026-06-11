const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface OpenAPIParameter {
  in: ParameterLocation;
  name: string;
  required?: boolean;
  schema?: {
    items?: {
      type?: string | string[];
    };
    type?: string | string[];
  };
}

export interface OpenAPIContent {
  schema?: unknown;
}

export interface OpenAPIRequestBody {
  content?: Record<string, OpenAPIContent>;
  required?: boolean;
}

export interface OpenAPIResponse {
  content?: Record<string, OpenAPIContent>;
  description?: string;
}

export type OpenAPIAccessKind = "authenticated" | "internal" | "public" | "role";

export interface OpenAPIAccessExtension {
  kind: OpenAPIAccessKind;
  roles?: string[];
}

export type OpenAPISecurityRequirement = Record<string, string[]>;

export interface OpenAPISecurityScheme {
  type?: string;
  scheme?: string;
}

export interface OpenAPIOperation {
  operationId?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse>;
  tags?: string[];
  security?: OpenAPISecurityRequirement[];
}

export type OpenAPIPathItem = Partial<Record<HttpMethod, OpenAPIOperation>>;

export interface OpenAPISchema {
  items?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

export interface OpenAPISpec {
  paths?: Record<string, OpenAPIPathItem>;
  security?: OpenAPISecurityRequirement[];
  components?: {
    schemas?: Record<string, OpenAPISchema>;
    securitySchemes?: Record<string, OpenAPISecurityScheme>;
  };
}

export interface OperationEntry {
  apiPath: string;
  funcName: string;
  group: string;
  method: HttpMethod;
  operation: OpenAPIOperation;
  operationId: string;
  strippedPath: string;
}

export interface NormalizedChannel {
  present: boolean;
  required: boolean;
  typeRef: NormalizedTypeReference | null;
}

export interface NormalizedTypeReference {
  aliasDefinitionExpr: string | null;
  sourceExpr: string;
  typeName: string;
}

export interface NormalizedOperation {
  bodyChannel: NormalizedChannel;
  bodyContentType: BodyContentType | null;
  builderAlias: string;
  entry: OperationEntry;
  optionTypeName: string;
  pathChannel: NormalizedChannel;
  pathInvocationExpr: string;
  queryChannel: NormalizedChannel;
  requestFunction: string;
  responseTypeRef: NormalizedTypeReference | null;
  returnTypeExpr: string;
}

export interface ClientRenderModel {
  operations: NormalizedOperation[];
  needsSearchParamsHelper: boolean;
  typeAliases: TypeAliasDefinition[];
}

export interface TypeAliasDefinition {
  definitionExpr: string;
  typeName: string;
}

interface NormalizationContext {
  schemaAliasIndex: Map<string, string[]>;
  schemaNames: Set<string>;
  usedTypeNames: Set<string>;
}

interface SuccessResponseInfo {
  hasJsonBody: boolean;
  statusKey: string;
}

export type BodyContentType = "json" | "binary" | "formData";

export function buildClientRenderModelFromOperations(
  operations: OperationEntry[],
  spec: OpenAPISpec,
  requestFunctionNames: { json: string; void: string } = {
    json: "requestJson",
    void: "requestVoid",
  },
): ClientRenderModel {
  const context = buildNormalizationContext(spec);
  const normalized = operations.map((entry) =>
    normalizeOperation(entry, context, requestFunctionNames),
  );

  return {
    operations: normalized,
    needsSearchParamsHelper: normalized.some((operation) => operation.queryChannel.present),
    typeAliases: collectTypeAliases(normalized),
  };
}

export function collectOperations(
  spec: OpenAPISpec,
  pathPrefix = "/api/",
  stripPrefix = true,
): OperationEntry[] {
  const apiPaths = Object.keys(spec.paths ?? {})
    .filter((path) => path.startsWith(pathPrefix))
    .sort();

  if (apiPaths.length === 0) {
    throw new Error(`No paths matching prefix "${pathPrefix}" found in openapi.json`);
  }

  const entries: OperationEntry[] = [];

  for (const apiPath of apiPaths) {
    const pathItem = spec.paths?.[apiPath];
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;

      const strippedPath = stripPrefix ? apiPath.replace(pathPrefix, "") : apiPath;
      entries.push({
        apiPath,
        funcName: makeFuncName(operation.operationId, method, apiPath, pathPrefix),
        group: strippedPath.split("/")[0] ?? "misc",
        method,
        operation,
        operationId: operation.operationId,
        strippedPath,
      });
    }
  }

  return entries;
}

export function getEffectiveParametersByLocation(
  entry: OperationEntry,
  location: ParameterLocation,
): OpenAPIParameter[] {
  return (entry.operation.parameters ?? []).filter(
    (parameter) => getEffectiveParameterLocation(entry.apiPath, parameter) === location,
  );
}

export function warnOnParameterLocationMismatch(operations: OperationEntry[]): void {
  for (const entry of operations) {
    for (const parameter of entry.operation.parameters ?? []) {
      const effectiveLocation = getEffectiveParameterLocation(entry.apiPath, parameter);
      if (effectiveLocation === parameter.in) {
        continue;
      }

      console.warn(
        `[openapi-codegen] normalized parameter "${parameter.name}" for "${entry.operationId}" from ${parameter.in} to ${effectiveLocation}.`,
      );
    }
  }
}

function buildNormalizationContext(spec: OpenAPISpec): NormalizationContext {
  const schemaAliasIndex = new Map<string, string[]>();
  const schemaNames = new Set<string>();

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    schemaNames.add(name);

    const props = Object.keys(schema.properties ?? {})
      .sort()
      .join(",");
    if (!props) {
      continue;
    }

    if (!schemaAliasIndex.has(props)) {
      schemaAliasIndex.set(props, []);
    }

    schemaAliasIndex.get(props)?.push(name);
  }

  return {
    schemaAliasIndex,
    schemaNames,
    usedTypeNames: new Set(schemaNames),
  };
}

function getParametersByLocation(
  operation: OpenAPIOperation,
  location: ParameterLocation,
): OpenAPIParameter[] {
  return (operation.parameters ?? []).filter((parameter) => parameter.in === location);
}

function hasRequiredChannel(parameters: OpenAPIParameter[]): boolean {
  return parameters.some((parameter) => parameter.required);
}

function getSuccessResponseInfo(operation: OpenAPIOperation): SuccessResponseInfo {
  const successResponses = Object.entries(operation.responses ?? {})
    .filter(([statusKey]) => isSuccessStatus(statusKey))
    .sort(([left], [right]) => Number(left) - Number(right));

  if (successResponses.length === 0) {
    throw new Error(
      `Operation "${operation.operationId ?? "unknown"}" has no 2xx success response`,
    );
  }

  const withJson = successResponses.find(([, response]) => response.content?.["application/json"]);
  if (withJson) {
    return {
      hasJsonBody: true,
      statusKey: withJson[0],
    };
  }

  return {
    hasJsonBody: false,
    statusKey: successResponses[0][0],
  };
}

function isSuccessStatus(statusKey: string): boolean {
  const value = Number(statusKey);
  return Number.isInteger(value) && value >= 200 && value < 300;
}

function formatStatusKey(statusKey: string): string {
  return Number.isInteger(Number(statusKey)) ? statusKey : `'${statusKey}'`;
}

function getBuilderAlias(funcName: string): string {
  return `build${capitalize(funcName)}Path`;
}

function getClientOptionTypeName(funcName: string): string {
  return `${capitalize(funcName)}Options`;
}

function makeFuncName(
  operationId: string,
  method: HttpMethod,
  apiPath: string,
  pathPrefix = "/api/",
): string {
  const normalizedOperationId = toFunctionName(operationId);
  if (normalizedOperationId.length > 0) {
    return normalizedOperationId;
  }

  const segments = apiPath.replace(pathPrefix, "").split("/");
  const result: string[] = [];

  for (const segment of segments) {
    if (segment.startsWith("{")) {
      const resource = segment.slice(1, -1).replace(/_id$/, "");
      if (result.length > 0) {
        result[result.length - 1] = resource;
      }
      continue;
    }

    result.push(segment);
  }

  const camelParts = result.map((segment, index) => {
    const clean = segment.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    return index === 0 ? clean : `${clean[0].toUpperCase()}${clean.slice(1)}`;
  });
  const baseName = camelParts.join("");
  return `${method}${capitalize(baseName)}`;
}

function toFunctionName(value: string): string {
  const segments = value
    .split(/[^a-zA-Z0-9]+/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "";
  }

  const [firstSegment, ...restSegments] = segments;
  const normalized = [
    firstSegment[0].toLowerCase() + firstSegment.slice(1),
    ...restSegments.map((segment) => capitalize(segment.toLowerCase())),
  ].join("");

  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function getEffectiveParameterLocation(
  apiPath: string,
  parameter: OpenAPIParameter,
): ParameterLocation {
  if (parameter.in !== "path") {
    return parameter.in;
  }

  return getTemplateParameterNames(apiPath).has(parameter.name) ? "path" : "query";
}

function getTemplateParameterNames(apiPath: string): Set<string> {
  const matches = apiPath.match(/\{(\w+)\}/g) ?? [];
  return new Set(matches.map((match) => match.slice(1, -1)));
}

function resolveParameterTypeReference(
  entry: OperationEntry,
  context: NormalizationContext,
  location: "path" | "query",
): NormalizedTypeReference | null {
  const effectiveParameters = getEffectiveParametersByLocation(entry, location);
  if (effectiveParameters.length === 0) {
    return null;
  }

  const schemaTypeRef = resolveAlias(
    context,
    effectiveParameters.map((parameter) => parameter.name),
    entry.operation.tags?.[0],
  );
  if (schemaTypeRef) {
    return schemaTypeRef;
  }

  const rawParameters = getParametersByLocation(entry.operation, location);
  const typeName = allocateOperationTypeName(
    context,
    entry.funcName,
    location === "path" ? "Path" : "Query",
  );
  if (hasSameParameterNames(rawParameters, effectiveParameters)) {
    return {
      aliasDefinitionExpr: `operations['${entry.operationId}']['parameters']['${location}']`,
      sourceExpr: `operations['${entry.operationId}']['parameters']['${location}']`,
      typeName,
    };
  }

  return {
    aliasDefinitionExpr: renderInlineParameterObject(effectiveParameters),
    sourceExpr: renderInlineParameterObject(effectiveParameters),
    typeName,
  };
}

function normalizeOperation(
  entry: OperationEntry,
  context: NormalizationContext,
  requestFunctionNames: { json: string; void: string },
): NormalizedOperation {
  const successResponse = getSuccessResponseInfo(entry.operation);
  const builderAlias = getBuilderAlias(entry.funcName);
  const pathChannel = normalizeParameterChannel(entry, context, "path");
  const queryChannel = normalizeParameterChannel(entry, context, "query");
  const bodyResolution = normalizeBodyChannel(entry, context);
  const responseTypeRef = resolveResponseTypeReference(entry, context, successResponse);

  return {
    bodyChannel: bodyResolution.channel,
    bodyContentType: bodyResolution.contentType,
    builderAlias,
    entry,
    optionTypeName: getClientOptionTypeName(entry.funcName),
    pathChannel,
    pathInvocationExpr: pathChannel.present ? `${builderAlias}(options.path)` : `${builderAlias}()`,
    queryChannel,
    requestFunction: responseTypeRef ? requestFunctionNames.json : requestFunctionNames.void,
    responseTypeRef,
    returnTypeExpr: responseTypeRef ? `Promise<${responseTypeRef.typeName}>` : "Promise<void>",
  };
}

function normalizeParameterChannel(
  entry: OperationEntry,
  context: NormalizationContext,
  location: "path" | "query",
): NormalizedChannel {
  const parameters = getEffectiveParametersByLocation(entry, location);
  if (parameters.length === 0) {
    return {
      present: false,
      required: false,
      typeRef: null,
    };
  }

  return {
    present: true,
    required: hasRequiredChannel(parameters),
    typeRef: resolveParameterTypeReference(entry, context, location),
  };
}

function normalizeBodyChannel(
  entry: OperationEntry,
  context: NormalizationContext,
): { channel: NormalizedChannel; contentType: BodyContentType | null } {
  const requestBody = entry.operation.requestBody;
  if (!requestBody) {
    return {
      channel: {
        present: false,
        required: false,
        typeRef: null,
      },
      contentType: null,
    };
  }

  const content = requestBody.content ?? {};
  const jsonBody = content["application/json"];
  if (jsonBody) {
    return {
      channel: createRequestBodyChannel(entry, context, jsonBody, "json"),
      contentType: "json",
    };
  }

  const binaryBody = content["application/octet-stream"];
  if (binaryBody) {
    return {
      channel: createRequestBodyChannel(entry, context, binaryBody, "binary"),
      contentType: "binary",
    };
  }

  const multipartBody = content["multipart/form-data"];
  if (multipartBody) {
    return {
      channel: createRequestBodyChannel(entry, context, multipartBody, "formData"),
      contentType: "formData",
    };
  }

  throw new Error(
    `Operation "${entry.operationId ?? "unknown"}" has a requestBody but no supported content type`,
  );
}

function createRequestBodyChannel(
  entry: OperationEntry,
  context: NormalizationContext,
  body: OpenAPIContent,
  kind: BodyContentType,
): NormalizedChannel {
  const typeRef = resolveRequestBodyTypeReference(entry, context, body, kind);
  if (!typeRef) {
    return {
      present: false,
      required: false,
      typeRef: null,
    };
  }

  return {
    present: true,
    required: entry.operation.requestBody?.required === true,
    typeRef,
  };
}

function resolveRequestBodyTypeReference(
  entry: OperationEntry,
  context: NormalizationContext,
  body: OpenAPIContent,
  kind: BodyContentType,
): NormalizedTypeReference | null {
  if (kind === "formData") {
    return {
      aliasDefinitionExpr: "FormData",
      sourceExpr: "FormData",
      typeName: allocateOperationTypeName(context, entry.funcName, "Request"),
    };
  }

  if (kind === "binary") {
    return {
      aliasDefinitionExpr: "Blob | File | ArrayBuffer | string",
      sourceExpr: "Blob | File | ArrayBuffer | string",
      typeName: allocateOperationTypeName(context, entry.funcName, "Request"),
    };
  }

  const schemaTypeRef = resolveSchemaTypeReference(context, body.schema);
  if (schemaTypeRef) {
    return schemaTypeRef;
  }

  return {
    aliasDefinitionExpr: `operations['${entry.operationId}']['requestBody']['content']['application/json']`,
    sourceExpr: `operations['${entry.operationId}']['requestBody']['content']['application/json']`,
    typeName: allocateOperationTypeName(context, entry.funcName, "Request"),
  };
}

function resolveResponseTypeReference(
  entry: OperationEntry,
  context: NormalizationContext,
  successResponse: SuccessResponseInfo,
): NormalizedTypeReference | null {
  if (!successResponse.hasJsonBody) {
    return null;
  }

  const response = entry.operation.responses?.[successResponse.statusKey];
  const jsonContent = response?.content?.["application/json"];
  const schemaTypeRef = resolveSchemaTypeReference(context, jsonContent?.schema);
  if (schemaTypeRef) {
    return schemaTypeRef;
  }

  return {
    aliasDefinitionExpr: `operations['${entry.operationId}']['responses'][${formatStatusKey(
      successResponse.statusKey,
    )}]['content']['application/json']`,
    sourceExpr: `operations['${entry.operationId}']['responses'][${formatStatusKey(
      successResponse.statusKey,
    )}]['content']['application/json']`,
    typeName: allocateOperationTypeName(context, entry.funcName, "Response"),
  };
}

function hasSameParameterNames(left: OpenAPIParameter[], right: OpenAPIParameter[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftNames = left.map((parameter) => parameter.name).sort();
  const rightNames = right.map((parameter) => parameter.name).sort();
  return leftNames.every((name, index) => name === rightNames[index]);
}

function resolveAlias(
  context: NormalizationContext,
  parameterNames: string[],
  tag?: string,
): NormalizedTypeReference | undefined {
  const key = [...parameterNames].sort().join(",");
  const candidates = context.schemaAliasIndex.get(key);
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  if (candidates.length === 1) {
    return createSchemaTypeReference(candidates[0]);
  }

  if (tag) {
    const singularTag = tag.replace(/s$/, "");
    const prefix = `${singularTag[0]?.toUpperCase() ?? ""}${singularTag.slice(1)}`;
    const match = candidates.find((candidate) => candidate.startsWith(prefix));
    if (match) {
      return createSchemaTypeReference(match);
    }
  }

  return createSchemaTypeReference(candidates[0]);
}

function resolveSchemaTypeReference(
  context: NormalizationContext,
  schema: unknown,
): NormalizedTypeReference | undefined {
  const ref = readSchemaRef(schema);
  if (!ref) {
    return undefined;
  }

  const schemaName = ref.split("/").pop();
  if (!schemaName || !context.schemaNames.has(schemaName)) {
    return undefined;
  }

  return createSchemaTypeReference(schemaName);
}

function createSchemaTypeReference(schemaName: string): NormalizedTypeReference {
  return {
    aliasDefinitionExpr: null,
    sourceExpr: `components['schemas']['${schemaName}']`,
    typeName: schemaName,
  };
}

function readSchemaRef(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }

  const maybeRef = (schema as { $ref?: unknown }).$ref;
  return typeof maybeRef === "string" ? maybeRef : undefined;
}

function renderInlineParameterObject(parameters: OpenAPIParameter[]): string {
  const properties = parameters.map((parameter) => {
    const optionalMarker = parameter.required ? "" : "?";
    return `${parameter.name}${optionalMarker}: ${renderPrimitiveSchemaType(parameter.schema)}`;
  });

  return `{ ${properties.join("; ")} }`;
}

function renderPrimitiveSchemaType(schema: OpenAPIParameter["schema"]): string {
  const type = schema?.type;
  if (!type) {
    return "unknown";
  }

  if (Array.isArray(type)) {
    return type.map((memberType) => mapPrimitiveType(memberType)).join(" | ");
  }

  if (type === "array") {
    return `${renderPrimitiveSchemaType(schema.items)}[]`;
  }

  return mapPrimitiveType(type);
}

function allocateOperationTypeName(
  context: NormalizationContext,
  funcName: string,
  suffix: "Path" | "Query" | "Request" | "Response",
): string {
  const preferredName = `${capitalize(funcName)}${suffix}`;
  if (!context.usedTypeNames.has(preferredName)) {
    context.usedTypeNames.add(preferredName);
    return preferredName;
  }

  let counter = 2;
  let candidate = `${preferredName}_${counter}`;
  while (context.usedTypeNames.has(candidate)) {
    counter += 1;
    candidate = `${preferredName}_${counter}`;
  }

  context.usedTypeNames.add(candidate);
  return candidate;
}

function collectTypeAliases(operations: NormalizedOperation[]): TypeAliasDefinition[] {
  const aliases = new Map<string, string>();

  for (const operation of operations) {
    collectTypeAlias(aliases, operation.pathChannel.typeRef);
    collectTypeAlias(aliases, operation.queryChannel.typeRef);
    collectTypeAlias(aliases, operation.bodyChannel.typeRef);
    collectTypeAlias(aliases, operation.responseTypeRef);
  }

  return [...aliases.entries()]
    .map(([typeName, definitionExpr]) => ({ definitionExpr, typeName }))
    .sort((left, right) => left.typeName.localeCompare(right.typeName));
}

function collectTypeAlias(
  aliases: Map<string, string>,
  typeRef: NormalizedTypeReference | null,
): void {
  if (!typeRef || typeRef.aliasDefinitionExpr == null) {
    return;
  }

  const existing = aliases.get(typeRef.typeName);
  if (existing && existing !== typeRef.aliasDefinitionExpr) {
    throw new Error(
      `Conflicting generated type alias "${typeRef.typeName}" with incompatible definitions.`,
    );
  }

  aliases.set(typeRef.typeName, typeRef.aliasDefinitionExpr);
}

function mapPrimitiveType(type: string): string {
  switch (type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "string":
      return "string";
    default:
      return "unknown";
  }
}
