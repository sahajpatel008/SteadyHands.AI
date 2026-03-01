# Unit Test Cases

## `src/lib/actionExecutor.ts`

1. Serialize click action and include click branch logic.
2. Serialize type action with escaped special characters.
3. Toggle highlight branch correctly for enabled vs disabled.
4. Include navigate branch and navigation success response.

## `src/lib/contentExtractor.ts`

1. Inject requested `textLimit` into body text slicing.
2. Include expected interactive selectors used for extraction.
3. Preserve explicit zero-limit behavior (`slice(0, 0)`).

## `electron/main/config.ts`

1. Parse valid environment values with number coercion and boolean conversion.
2. Return sanitized public config shape from `getPublicConfig`.
3. Reject invalid planner model ids that contain unsupported characters.
4. Reject confidence thresholds outside the `[0, 1]` range.
