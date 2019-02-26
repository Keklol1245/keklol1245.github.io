import * as _ from 'lodash';
import { get } from 'typesafe-get';

import {
    findApi,
    OpenAPIObject,
    PathObject,
    OperationObject,
    ParameterObject,
    ResponseObject,
    RequestBodyObject,
    SchemaObject
} from 'openapi-directory';
import * as Ajv from 'ajv';
import * as Remarkable from 'remarkable';
import * as DOMPurify from 'dompurify';

import { HttpExchange, HtkResponse, HtkRequest, Html } from "../../types";
import { firstMatch, ObservablePromise, observablePromise } from '../../util';
import { reportError } from '../../errors';

import { ApiMetadata, Parameter, ApiExchange } from './openapi-types';
import { buildApiMetadataAsync } from '../../workers/worker-api';

const apiCache: _.Dictionary<ObservablePromise<ApiMetadata>> = {};

export function getMatchingAPI(exchange: HttpExchange): ObservablePromise<ApiMetadata> | undefined {
    const { parsedUrl } = exchange.request;
    const requestUrl = `${parsedUrl.hostname}${parsedUrl.pathname}`;
    const specId = findApi(requestUrl);

    if (!specId || Array.isArray(specId)) return; // We don't bother dealing with overlapping APIs yet

    if (!apiCache[specId]) {
        apiCache[specId] = observablePromise(
            fetchApiMetadata(specId).then(buildApiMetadataAsync).catch((e) => {
                reportError(e);
                throw e;
            })
        );
    }

    return apiCache[specId];
}

async function fetchApiMetadata(specId: string): Promise<OpenAPIObject> {
    const specResponse = await fetch(`/api/${specId}.json`);
    return specResponse.json();
}


const paramValidator = new Ajv({
    coerceTypes: 'array',
    unknownFormats: 'ignore' // OpenAPI uses some non-standard formats
});

const md = new Remarkable({
    html: true,
    linkify: true
});

export function getPath(api: ApiMetadata, exchange: HttpExchange): {
    pathData: PathObject,
    path: string
} | undefined {
    const { parsedUrl } = exchange.request;

    // Request URL without query params
    const url = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;

    // Test the base server up front, just to keep things quick
    if (!api.serverMatcher.exec(url)) return;

    for (let matcher of api.pathMatchers.keys()) {
        if (matcher.exec(url)) {
            return api.pathMatchers.get(matcher);
        }
    }
}

export function getParameters(
    path: string,
    parameters: ParameterObject[],
    exchange: HttpExchange
): Parameter[] {
    if (!parameters) return [];

    const query = exchange.request.parsedUrl.searchParams;

    // Need the cast because TS doesn't know we've already dereferenced this
    return _.uniqBy(<ParameterObject[]>parameters, (param) =>
        `${param.name}::${param.in}`
    )
        .map((param) => {
            const schema = param.schema as SchemaObject | undefined;

            const commonFields = {
                specParam: param,
                name: param.name,
                in: param.in,
                description: fromMarkdown(param.description),
                required: param.required || param.in === 'path',
                defaultValue: schema && schema.default,
                deprecated: param.deprecated || false,
                validationErrors: <string[]>[]
            }

            switch (param.in) {
                case 'query':
                    const values = query.getAll(param.name);
                    return {
                        ...commonFields,
                        value: firstMatch<string[] | string | undefined>(
                            [() => values.length > 1, values],
                            [() => values.length === 1, values[0]]
                        )
                    };

                case 'path':
                    // If we had regex named groups, we could do this up front
                    // with one single regex... Alas, not widespread yet.
                    const paramMatcher = new RegExp(
                        path
                            // Add a capturing group for this param
                            .replace(`{${param.name}}`, '([^/]+)')
                            // Add a non-capturing group for every other param
                            .replace(/\{[^\}]+\}/g, '[^/]+')
                        + '$', // Matched path must be a complete suffix.
                        'i' // Match paths ignoring case (matters in theory, never in practice)
                    );

                    const match = paramMatcher.exec(exchange.request.path);
                    return {
                        ...commonFields,
                        value: match ? match[1] : undefined
                    };

                case 'header':
                    return {
                        ...commonFields,
                        value: exchange.request.headers[param.name.toLowerCase()]
                    }

                // TODO: Match in:cookie too (but currently no example in the specs)
                default:
                    return {
                        ...commonFields,
                        value: undefined
                    }
            }
        })
        .map((param) => {
            const { specParam } = param;

            if (param.required && param.value === undefined && param.defaultValue === undefined) {
                param.validationErrors.push(
                    `The '${param.name}' ${specParam.in} parameter is required.`
                );
            }

            if (param.deprecated && param.value !== undefined) {
                param.validationErrors.push(
                    `The '${param.name}' ${specParam.in} parameter is deprecated.`
                );
            }

            if (specParam.schema && param.value !== undefined) {
                // Validate against the schema. We wrap the value in an object
                // so that ajv can mutate the input to coerce to the right type.
                const valueWrapper = { value: param.value };
                const validated = paramValidator.validate({
                    "type": "object",
                    "properties": {
                        "value": specParam.schema
                    }
                }, valueWrapper);

                if (!validated && paramValidator.errors) {
                    param.validationErrors.push(
                        ...paramValidator.errors.map(e =>
                            `'${
                                e.dataPath.replace(/^\.value/, param.name)
                            }' ${e.message!}.`
                        )
                    );
                }

                param.value = valueWrapper.value;
            }

            return {
                ...param,
                validationErrors: param.validationErrors.map(e => stripTags(e))
            };
        });
}

export function getBody(
    bodyDefinition: RequestBodyObject | ResponseObject | undefined,
    message: HtkRequest | HtkResponse | 'aborted' | undefined
): SchemaObject {
    if (!bodyDefinition || !message || message === 'aborted') return {};

    const contentType = message.headers['content-type'] || '*/*';

    const schemasByType = bodyDefinition.content;
    if (!schemasByType) return {};

    // Sort the keys by the number of *'s present
    const mediaTypeKeys = _.sortBy(Object.keys(schemasByType),
        (key) => _.sumBy(key, (c: string) => c === '*' ? 1 : 0)
    );

    const schemaKey = _.find<string>(mediaTypeKeys, (key) =>
        new RegExp('^' + // Must match at the start
            key.replace('*', '.*') // Wildcards to regex wildcard
                .replace(/;.*/, '') // Ignore charset etc
        ).exec(contentType) !== null
    );

    if (!schemaKey) return {};

    return Object.assign(
        { description: bodyDefinition.description },
        schemasByType[schemaKey].schema
    );
}

function getDummyPath(api: ApiMetadata, exchange: HttpExchange): string {
    const { parsedUrl } = exchange.request;
    const url = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;
    const serverMatch = api.serverMatcher.exec(url);

    if (!serverMatch) {
        return parsedUrl.pathname;
    }

    // Everything after the server is our API path
    return url.slice(serverMatch[0].length);
}

function isCompletedResponse(response: any): response is HtkResponse {
    return !!response.statusCode;
}

function fromMarkdown(input: string): Html;
function fromMarkdown(input: string | undefined): Html | undefined;
function fromMarkdown(input: string | undefined): Html | undefined {
    if (!input) return undefined;
    else {
        const unsafeMarkdown = md.render(input).replace(/\n$/, '');
        const safeHtml = DOMPurify.sanitize(unsafeMarkdown);
        return { __html: safeHtml };
    }
}

// Rough but effective HTML stripping regex. This is _not_ designed to produce HTML-safe
// input, it's just designed to turn formatted text into simple text.
function stripTags(input: string): string;
function stripTags(input: undefined): undefined;
function stripTags(input: string | undefined): string | undefined {
    if (!input) return input;

    // Need to cast to string, as dompurify may returned TrustedHTML, in
    // environments where that's supported.
    return (input + '').replace(/(<([^>]+)>)/ig, '');
}

export function parseExchange(api: ApiMetadata, exchange: HttpExchange): ApiExchange {
    const { info: service } = api.spec;
    const { request, response } = exchange;

    const validationErrors: string[] = [];

    const serviceTitle = service.title;
    const serviceLogoUrl = service['x-logo'].url
    const serviceDescription = fromMarkdown(service.description);
    const serviceDocsUrl = get(api, 'spec', 'externalDocs', 'url');

    const matchingPath = getPath(api, exchange);

    const { pathData, path } = matchingPath || {
        pathData: {}, path: getDummyPath(api, exchange)
    }

    const operation: OperationObject | _.Dictionary<never> = get(
        pathData, request.method.toLowerCase()
    ) || {};

    const operationDocsUrl = get(operation, 'externalDocs', 'url');

    const operationName = stripTags(fromMarkdown(
        firstMatch<string>(
            [
                () => (get(operation, 'summary', 'length') || Infinity) < 40, operation.summary!
            ],
            get(operation, 'operationId'),
            [
                () => (get(operation, 'description', 'length') || Infinity) < 40, operation.description!
            ],
            pathData.summary
        ) || `${request.method} ${path}`
    ).__html);

    const operationDescription = firstMatch<string>(
        [() => get(operation, 'description') !== operationName, get(operation, 'description')],
        [() => get(operation, 'summary') !== operationName, get(operation, 'summary')],
        pathData.description
    );

    if (!matchingPath) validationErrors.push(
        `Unknown operation '${operationName}'.`
    );

    if (operation.deprecated) validationErrors.push(
        `The '${operationName}' operation is deprecated.`
    );

    const parameters = operation ? getParameters(
        path!,
        (pathData.parameters || []).concat(operation.parameters || []),
        exchange
    ) : [];

    let responseSpec: ResponseObject | undefined;
    let responseDescription: string | undefined;
    if (get(operation, 'responses') && isCompletedResponse(response)) {
        responseSpec = operation.responses[response.statusCode.toString()] ||
            operation.responses.default;
        responseDescription = responseSpec ? responseSpec.description : response.statusMessage;
    }

    return {
        serviceTitle,
        serviceLogoUrl,
        serviceDescription,
        serviceDocsUrl,
        operationName,
        operationDescription: fromMarkdown(operationDescription),
        operationDocsUrl,
        parameters,
        requestBody: getBody(operation.requestBody as RequestBodyObject | undefined, exchange.request),
        responseDescription: fromMarkdown(responseDescription),
        responseBody: getBody(responseSpec, exchange.response),
        validationErrors: validationErrors.map(e => stripTags(e))
    };
}