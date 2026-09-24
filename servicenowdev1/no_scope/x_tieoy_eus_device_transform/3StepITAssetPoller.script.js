/**
 * 3StepIT Asset Poller (Action Rule script)
 *
 * Runtime variables provided by the Action Rule engine:
 * - glideRecord: GlideRecord for u_integration_customer
 * - logger: GSLog instance for consolidated execution logging
 * - current: Transform/action entry definition record
 * - rule: Action rule record (optional, depends on execution context)
 *
 * High-level flow:
 * 1) Validate integration record and parse config.
 * 2) Decrypt client secret and fetch OAuth bearer token.
 * 3) Read changed local workstation CIs and write back one-by-one via PUT (OUTBOUND first).
 * 4) Update local read cursor in integrationGR.u_poller_cursor.
 * 5) Fetch 3StepIT assets with remote read timestamp filter (INBOUND second — picks up ping-backs from step 3).
 * 6) Map each asset to u_3stepit_asset_row and insert.
 * 7) Derive remote read timestamp from x_tieoy_eus_device_row.custom_1 (raw ISO changetime, timezone-safe).
 *
 * Integration config schema (integrationGR.u_config):
 * {
 *   "api_key": "<x-api-key>",
 *   "remote_query_params": {
 *     "columns": "changedate,changetime,company,financialtype,serialnumber",
 *     "filter": "optional API-specific filter"
 *   },
 *   "local_query_filter": "install_status!=7^...",
 *   "local_read_timestamp": "2026-04-01 00:00:00",
 *   "local_read_timestamp_seed": "2026-01-01 00:00:00",
 *   "remote_read_timestamp": "2026-04-01 00:00:00",
 *   "remote_read_timestamp_seed": "2026-01-01 00:00:00"
 * }
 */

var eusBaseUtil = new global.EusBaseUtil();
var appHelper = new global.PCACappHelper();
var JSUtil = global.JSUtil;
var logArr = [];
var logLevel = "info"; // default; overridden in action() from integrationGR.u_log_level
var MAX_READ_RECORDS = 500;
var MAX_WRITE_RECORDS = 100;
var MAX_FETCH_ATTEMPTS = 3;


(function() {
    try {

        var currentUser = gs.getUser().getID();
        appHelper.impersonateUser('3stepit.integration'); // Impersonate dedicated integration user for token fetch and asset query

        var result = action(glideRecord); // Result should be the latest log entry and passed to AR result

        // Execution log print out, all at once
        if (logArr.length > 0) {
            //logger.logInfo("execution log:\n" + logArr.join("\n")); // for BG script running
        }

        // Target record update
        if (typeof rule === "undefined") {
            // calling from somewhere else than the rule
        } else {
            // calling from an action rule (or from BG script)
            rule.result += glideRecord.getDisplayValue() + " -- execution log:\n" + logArr.join("\n") + "\n\n";
            // log to system log as well to see the also the history
            logger.logInfo("3StepIT Asset Poller -- " + glideRecord.getDisplayValue() + ": " + result);
        }
        appHelper.impersonateUser(currentUser); // Revert impersonation
        return "";
    } catch (e) {
        appHelper.impersonateUser(currentUser); // Revert to original user in case of exception
        return ("Exception in x_tieoy_eus_device_transform [" + current.getDisplayValue() + "] on line " + e.lineNumber + ": " + e.message + " --> " + JSON.stringify(e));
    }
})();

/**
 * Executes one synchronous polling run.
 *
 * Responsibilities:
 * - Validate mandatory connection/config fields.
 * - Acquire token and fetch asset payload.
 * - Process row-by-row so individual record errors do not abort the whole run.
 * - Advance watermark only after successful processing loop.
 *
 * Assumptions:
 * - API supports filtering by changetime.
 * - Returned changetime values are ISO-like strings suitable for lexical comparison.
 * - Import table accepts mapped target fields (unknown fields are ignored during insert).
 *
 * @param {GlideRecord} integrationGR u_integration_customer record for one customer/integration.
 * @returns {String} Summary log line (also appended to action rule result when rule is present).
 */
function action(integrationGR) {
    var runStartedMs = new Date().getTime();

    if (!integrationGR || !integrationGR.isValidRecord()) {
        return endInError("Invalid integration record");
    }

    var allowedLogLevels = ["debug", "info", "warning", "error"];
    var configuredLogLevel = String(integrationGR.getValue("u_log_level") || "").toLowerCase();
    logLevel = allowedLogLevels.indexOf(configuredLogLevel) >= 0 ? configuredLogLevel : "debug";

    // Connection details
    var clientId = String(integrationGR.u_client_id || "");
    var clientSecretEncrypted = integrationGR.u_client_secret_encrypted;
    if (!clientId || JSUtil.nil(clientSecretEncrypted)) {
        return endInError("Missing required connection fields (u_client_id, u_client_secret_encrypted)");
    }
    var clientSecret = eusBaseUtil.getDecryptedStringV2(clientSecretEncrypted);
    var tokenEndpoint = String(integrationGR.u_token_url || "");
    var serviceEndpoint = String(integrationGR.u_url || "");

    if (!clientId || !clientSecretEncrypted || !tokenEndpoint || !serviceEndpoint) {
        return endInError("Missing required connection fields (u_client_id, u_client_secret_encrypted, u_token_url, u_url)");
    }

    var configObj;
    try {
        configObj = JSON.parse(String(integrationGR.u_config || "{}"));
    } catch (e) {
        return endInError("Error parsing integration configuration: " + e.message);
    }

    var apiKey = String(configObj.api_key || "");
    if (!apiKey) {
        return endInError("Missing api_key from integration u_config");
    }

    var remoteQueryParams = (configObj.remote_query_params && typeof configObj.remote_query_params === "object") ? configObj.remote_query_params : {};
    var localQueryFilter = String(configObj.local_query_filter || "");
    var localReadTimestampOverride = String(configObj.local_read_timestamp || "");
    var localReadTimestampSeed = String(configObj.local_read_timestamp_seed || "");
    var remoteReadTimestampOverride = String(configObj.remote_read_timestamp || "");
    var remoteReadTimestampSeed = String(configObj.remote_read_timestamp_seed || "");
    var requestedSerialNumbers = getRequestedSerialNumbersFromRule();
    var targetedRemoteFetchMode = requestedSerialNumbers.length > 0;

    addLog("Starting 3StepIT asset poll", "debug");
    if (targetedRemoteFetchMode) {
        addLog("Targeted remote fetch mode enabled via rule.parameter for serials: " + requestedSerialNumbers.join(", "), "info");
    } else if (remoteReadTimestampOverride) {
        addLog("Using remote_read_timestamp override from config: " + remoteReadTimestampOverride, "warning");
    }

    var tokenCacheKey = String(integrationGR.getUniqueValue()) + "|" + tokenEndpoint + "|" + clientId + "|" + apiKey;
    var token = getBearerTokenForRule(tokenCacheKey, tokenEndpoint, clientId, clientSecret, apiKey);
    if (!token) {
        return endInError("Token fetch failed");
    }

    var writeMetrics;
    if (targetedRemoteFetchMode) {
        writeMetrics = {
            candidates: 0,
            sent: 0,
            success: 0,
            deviceNotFound: 0,
            deviceEnded: 0,
            deviceDuplicate: 0,
            deviceDupeRetryOk: 0,
            deviceDupeRetryFail: 0,
            failed: 0,
            skipped: 1
        };
        addLog("Skipping local write sync because targeted remote fetch mode is active", "info");
    } else {
        writeMetrics = syncLocalChangesToRemote(integrationGR, serviceEndpoint, token, apiKey, localQueryFilter, localReadTimestampOverride, localReadTimestampSeed);
    }

    var queryMetrics = {
        queryMs: 0
    };
    var assets;
    if (targetedRemoteFetchMode) {
        assets = fetchAssetsForSerialNumbers(serviceEndpoint, token, apiKey, remoteQueryParams, requestedSerialNumbers, queryMetrics);
    } else {
        var remoteReadTimestamp = remoteReadTimestampOverride || getRemoteReadTimestampFromDeviceRows(integrationGR, remoteReadTimestampSeed);
        addLog("Remote read timestamp: " + (remoteReadTimestamp || "<empty>"), "debug");
        var effectiveQueryParams = buildAssetQueryParams(remoteQueryParams, remoteReadTimestamp);
        for(var attemptNumber = 0; attemptNumber < MAX_FETCH_ATTEMPTS; attemptNumber++){
             assets = fetchAssets(serviceEndpoint, token, apiKey, effectiveQueryParams, queryMetrics);
             if(assets){
                break;
             }else{
                // Build for the NEXT attempt (current+1): default -> half -> quarter window.
                effectiveQueryParams = buildAssetQueryParams(remoteQueryParams, remoteReadTimestamp, attemptNumber + 1);
             }
             }
       
    }

    if (assets === null) {
        return endInError("Asset fetch failed");
    }

    if (assets.length === MAX_READ_RECORDS && assets[0].changetime === assets[assets.length - 1].changetime) {
        return addLog("DUPLICATE_CHANGETIME_BATCH: All " + assets.length + " fetched assets share the same changetime (" + String(assets[0].changetime) + "). The remote read watermark cannot advance. Manual intervention required.", "warning");
    }

    var insertCount = 0;
    var skipCount = 0;
    var unchangedCount = 0;
    var integrationId = String(integrationGR.getUniqueValue());
    var topCompanyName = String(integrationGR.u_company.u_top_company.name || "");

    for (var i = 0; i < assets.length; i++) {
        var asset = assets[i];
        if (!asset || JSUtil.nil(asset.serialnumber) || JSUtil.nil(asset.changetime)) {
            skipCount++;
            addLog("Skipped asset index " + i + " due to missing serialnumber/changetime", "warning");
            continue;
        }

        try {
            var upsertResult = upsert3StepitSourceRow(integrationGR, asset);
            if (upsertResult && (upsertResult.inserted || upsertResult.changed)) {
                var mappedRow = mapAssetToImportRow(asset, integrationId, topCompanyName);
                var targetCi = insertImportRow(mappedRow);
                if (targetCi && upsertResult.rowSysId) {
                    updateDeviceRowTargetCi(upsertResult.rowSysId, targetCi);
                }
                addLog("target_ci " + (targetCi ? "set: " + targetCi : "not available (CI not matched)") + " for serial " + String(asset.serialnumber || ""), "debug");
                insertCount++;
            } else {
                unchangedCount++;
                addLog("Device row unchanged for serial " + String(asset.serialnumber) + ", skipping u_3stepit_asset_row insert", "debug");
            }
        } catch (rowErr) {
            skipCount++;
            addLog("Failed to process asset index " + i + ": " + rowErr.message, "error");
        }
    }

    if (!targetedRemoteFetchMode && assets.length > 0 && insertCount === 0 && unchangedCount === assets.length) {
        // All fetched assets are unchanged — the remote watermark (max custom_1) equals the highest
        // changetime in the batch, so the API filter "changetime ge <watermark>" would keep returning
        // the same devices forever. Fix: advance the custom_1 of the device with the highest changetime
        // by 1 ms, which shifts the watermark past the stuck value on the next run.
        var maxChangetimeAsset = null;
        var maxChangetime = "";
        for (var fallbackIdx = 0; fallbackIdx < assets.length; fallbackIdx++) {
            var fallbackAsset = assets[fallbackIdx];
            var assetChangetime = String((fallbackAsset && fallbackAsset.changetime) || "");
            if (assetChangetime && assetChangetime >= maxChangetime) {
                maxChangetime = assetChangetime;
                maxChangetimeAsset = fallbackAsset;
            }
        }

        if (!maxChangetimeAsset || !maxChangetime) {
            addLog("ALL_UNCHANGED_FALLBACK: No valid changetime among " + assets.length + " unchanged asset(s). Cannot advance watermark.", "warning");
        } else {
            var unchangedSerial = String((maxChangetimeAsset && maxChangetimeAsset.serialnumber) || "");
            var unchangedDeviceNumber = String((maxChangetimeAsset && maxChangetimeAsset.devicenumber) || "");
            var advancedChangetime = incrementIsoTimestampByMilliseconds(maxChangetime, 1);

            if (!advancedChangetime) {
                addLog("ALL_UNCHANGED_FALLBACK: Could not advance changetime for serial " + unchangedSerial + " (raw changetime: " + maxChangetime + ")", "warning");
            } else if (advancedChangetime === maxChangetime) {
                addLog("ALL_UNCHANGED_FALLBACK: Changetime could not be incremented for serial " + unchangedSerial + " (already at millisecond ceiling)", "warning");
            } else {
                try {
                    if (updateDeviceRowRemoteReadTimestamp(integrationGR, unchangedSerial, advancedChangetime, unchangedDeviceNumber)) {
                        addLog("ALL_UNCHANGED_FALLBACK: Advanced source row custom_1 by 1ms from " + maxChangetime + " to " + advancedChangetime + " for serial " + unchangedSerial + " (" + assets.length + " unchanged asset(s) in batch)", "info");
                    } else {
                        addLog("ALL_UNCHANGED_FALLBACK: Device row not found for serial " + unchangedSerial + ", timestamp not advanced", "warning");
                    }
                } catch (fallbackErr) {
                    addLog("ALL_UNCHANGED_FALLBACK: Failed to advance changetime for serial " + unchangedSerial + ": " + fallbackErr.message, "error");
                }
            }
        }
    }

    var processingSeconds = Math.round(((new Date().getTime() - runStartedMs) / 1000) * 1000) / 1000;
    var summary = "Fetched=" + assets.length + ", inserted=" + insertCount + ", unchanged=" + unchangedCount + ", skipped=" + skipCount +
        "\n" + "write_candidates=" + writeMetrics.candidates + ", write_sent=" + writeMetrics.sent + ", write_success=" + writeMetrics.success +
        ", write_device_not_found=" + writeMetrics.deviceNotFound + ", write_device_ended=" + writeMetrics.deviceEnded + ", write_device_duplicate=" + writeMetrics.deviceDuplicate + ", write_dupe_retry_ok=" + writeMetrics.deviceDupeRetryOk + ", write_dupe_retry_fail=" + writeMetrics.deviceDupeRetryFail + ", write_failed=" + writeMetrics.failed + ", write_skipped=" + writeMetrics.skipped +
        "\n" + "query_ms=" + queryMetrics.queryMs + ", processing_s=" + processingSeconds;
    return addLog(summary, "info");
    
}

/**
 * Fetches OAuth bearer token from the configured token endpoint.
 *
 * Request details:
 * - Method: POST
 * - Headers: Accept, Content-Type, x-api-key, Authorization: Basic (client_id/client_secret)
 * - Body: empty
 * - Timeout: 30 seconds
 *
 * Retry policy:
 * - Retries once on transport or HTTP failure (2 attempts total).
 * - Returns empty string on final failure.
 *
 * @param {String} tokenEndpoint OAuth token URL.
 * @param {String} clientId OAuth client id.
 * @param {String} clientSecret Decrypted OAuth client secret.
 * @param {String} apiKey API key value for x-api-key header.
 * @returns {String} Access token when successful, otherwise empty string.
 */
function getBearerToken(tokenEndpoint, clientId, clientSecret, apiKey) {
    for (var attempt = 1; attempt <= 1; attempt++) {
        try {
            var tokenRequest = new sn_ws.RESTMessageV2();
            tokenRequest.setEndpoint(tokenEndpoint);
            tokenRequest.setHttpMethod("post");
            tokenRequest.setRequestHeader("Accept", "application/json");
            tokenRequest.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
            tokenRequest.setRequestHeader("x-api-key", apiKey);
            tokenRequest.setBasicAuth(String(clientId), String(clientSecret));
            tokenRequest.setHttpTimeout(30000);
            tokenRequest.setRequestBody("");

            var tokenResponse = tokenRequest.execute();
            var tokenStatus = tokenResponse.getStatusCode();
            var tokenResponseBody = tokenResponse.getBody();

            if (tokenStatus < 200 || tokenStatus > 299) {
                addLog("Token request failed with HTTP " + tokenStatus + " (attempt " + attempt + ")" + (tokenResponseBody ? " body=" + tokenResponseBody : ""), "error");
                if (attempt === 2) {
                    return "";
                }
                continue;
            }

            var tokenObj;
            try {
                tokenObj = JSON.parse(tokenResponseBody);
            } catch (parseErr) {
                addLog("Token response parse error: " + parseErr.message, "error");
                return "";
            }

            if (tokenObj && tokenObj.access_token) {
                addLog("Token acquired", "debug");
                return String(tokenObj.access_token);
            }

            addLog("Token response missing access_token", "error");
            return "";
        } catch (err) {
            addLog("Token request exception (attempt " + attempt + "): " + err.message, "error");
            if (attempt === 2) {
                return "";
            }
        }
    }

    return "";
}

function getBearerTokenForRule(cacheKey, tokenEndpoint, clientId, clientSecret, apiKey) {
    if (typeof rule !== "undefined" && rule) {
        var tokenCache = rule._3stepitTokenCache;
        if (!tokenCache || typeof tokenCache !== "object") {
            tokenCache = {};
            rule._3stepitTokenCache = tokenCache;
        }
        if (tokenCache[cacheKey]) {
            addLog("Reusing cached 3StepIT bearer token for this Action Rule execution", "debug");
            return tokenCache[cacheKey];
        }

        var cachedToken = getBearerToken(tokenEndpoint, clientId, clientSecret, apiKey);
        if (cachedToken) {
            tokenCache[cacheKey] = cachedToken;
        }
        return cachedToken;
    }

    return getBearerToken(tokenEndpoint, clientId, clientSecret, apiKey);
}

/**
 * Builds query parameters for the asset endpoint.
 *
 * Behavior:
 * - Copies configured remote_query_params from integration config.
 * - Applies default columns when not configured.
 * - Appends delta filter "changetime ge <timestamp>" (see buildDeltaFilterForRemoteRead).
 * - Normalizes ServiceNow timestamp format to ISO before using it in API filter.
 * - Combines configured filter and delta filter with logical AND.
 *
 * @param {Object} baseParams Remote query params from integration config.
 * @param {String} remoteReadTimestamp Remote read timestamp.
 * @param {Number} [attemptNumber] Retry attempt index (0=default/unbounded, 1=half window, 2=quarter window); omit for the initial unbounded fetch.
 * @returns {Object} Effective query parameter object for RESTMessageV2.
 */
function buildAssetQueryParams(baseParams, remoteReadTimestamp, attemptNumber) {
    var params = {};
    var allowedParams = {
        columns: true,
        filter: true
    };
    for (var key in baseParams) {
        if (baseParams.hasOwnProperty(key) && allowedParams[key] && !JSUtil.nil(baseParams[key])) {
            params[key] = String(baseParams[key]);
        }
    }

    if (!params.columns) {
        params.columns = "changedate,changetime,company,financialtype,serialnumber";
    }

    if (remoteReadTimestamp) {
        var normalizedRemoteReadTimestamp = normalizeRemoteReadTimestampForApi(remoteReadTimestamp);
        var deltaFilter;
        if (typeof attemptNumber !== "undefined") {
            deltaFilter = buildDeltaFilterForRemoteRead(normalizedRemoteReadTimestamp, attemptNumber);
        } else {
            deltaFilter = buildDeltaFilterForRemoteRead(normalizedRemoteReadTimestamp);
        }

        if (params.filter) {
            params.filter = params.filter + " and " + deltaFilter;
        } else {
            params.filter = deltaFilter;
        }
    }

    return params;
}

/**
 * Reads action-rule parameter as a comma-separated serial number list.
 *
 * Example accepted value:
 * - "EM00PG8E, GM08LYED"
 *
 * @returns {Array} Unique serial numbers in input order.
 */
function getRequestedSerialNumbersFromRule() {
    if (typeof rule === "undefined" || JSUtil.nil(rule.parameter)) {
        return [];
    }

    var parameterRaw = String(rule.parameter || "").trim();
    if (!parameterRaw) {
        return [];
    }

    var parts = parameterRaw.split(",");
    var serialNumbers = [];
    var seen = {};

    for (var i = 0; i < parts.length; i++) {
        var serial = String(parts[i] || "").trim();
        if (!serial || seen[serial]) {
            continue;
        }
        seen[serial] = true;
        serialNumbers.push(serial);
    }

    return serialNumbers;
}

/**
 * Fetches assets with one remote query per requested serial number.
 *
 * Behavior:
 * - Uses configured remote_query_params columns/filter as base.
 * - Appends "serialnumber eq <serial>" to the filter for each request.
 * - Aggregates all responses into one sorted asset array.
 *
 * @param {String} serviceEndpoint Asset API endpoint URL.
 * @param {String} token Bearer token.
 * @param {String} apiKey API key for x-api-key header.
 * @param {Object} baseParams Remote query params from integration config.
 * @param {Array} serialNumbers Serial numbers requested via rule.parameter.
 * @param {Object} [metricsObj] Optional output metrics object; receives total queryMs.
 * @returns {Array|null} Aggregated asset array or null on failure.
 */
function fetchAssetsForSerialNumbers(serviceEndpoint, token, apiKey, baseParams, serialNumbers, metricsObj) {
    var allAssets = [];
    var totalQueryMs = 0;

    for (var i = 0; i < serialNumbers.length; i++) {
        var serialNumber = String(serialNumbers[i] || "").trim();
        if (!serialNumber) {
            continue;
        }

        var queryParams = buildAssetQueryParams(baseParams, "");
        var serialFilter = "serialnumber eq " + serialNumber;
        if (queryParams.filter) {
            queryParams.filter = queryParams.filter + " and " + serialFilter;
        } else {
            queryParams.filter = serialFilter;
        }

        addLog("Fetching targeted serial: " + serialNumber + " with filter: " + queryParams.filter, "info");
        var singleQueryMetrics = {
            queryMs: 0
        };
        var serialAssets = fetchAssets(serviceEndpoint, token, apiKey, queryParams, singleQueryMetrics);
        totalQueryMs += singleQueryMetrics.queryMs || 0;

        if (serialAssets === null) {
            addLog("Targeted fetch failed for serial: " + serialNumber, "error");
            return null;
        }

        for (var assetIndex = 0; assetIndex < serialAssets.length; assetIndex++) {
            allAssets.push(serialAssets[assetIndex]);
        }
    }

    if (metricsObj && typeof metricsObj === "object") {
        metricsObj.queryMs = totalQueryMs;
    }

    allAssets = sortAssetsByChangetime(allAssets);
    if (allAssets.length > MAX_READ_RECORDS) {
        addLog("Targeted fetch returned " + allAssets.length + " records, limiting processing to " + MAX_READ_RECORDS + " this run", "info");
        allAssets = allAssets.slice(0, MAX_READ_RECORDS);
    }

    addLog("Targeted fetch total asset count: " + allAssets.length, "info");
    return allAssets;
}

/**
 * Normalizes remote read timestamp into API-expected ISO format.
 *
 * Converts ServiceNow internal UTC format "yyyy-MM-dd HH:mm:ss" into
 * "yyyy-MM-ddTHH:mm:ss.SSSZ". Already-ISO values are normalized to include
 * millisecond precision when needed.
 *
 * @param {String} timestamp Raw remote read timestamp.
 * @returns {String} API-compatible timestamp string.
 */
function normalizeRemoteReadTimestampForApi(timestamp) {
    var raw = String(timestamp || "").trim();
    if (!raw) {
        return "";
    }

    // Already ISO-like (contains date/time separator T) -> normalize to include milliseconds.
    if (raw.indexOf("T") >= 0) {
        var isoNoMsZ = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z$/.exec(raw);
        if (isoNoMsZ) {
            return isoNoMsZ[1] + ".000Z";
        }

        var isoWithMsZ = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,})Z$/.exec(raw);
        if (isoWithMsZ) {
            var ms = String(isoWithMsZ[2]);
            if (ms.length > 3) {
                ms = ms.substring(0, 3);
            } else if (ms.length < 3) {
                ms = (ms + "000").substring(0, 3);
            }
            return isoWithMsZ[1] + "." + ms + "Z";
        }

        return raw;
    }

    // Convert ServiceNow internal UTC format to ISO UTC.
    var snDateTimeMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(raw);
    if (snDateTimeMatch) {
        var iso = snDateTimeMatch[1] + "T" + snDateTimeMatch[2] + ".000Z";
        addLog("Normalized remote read timestamp for API: " + raw + " -> " + iso);
        return iso;
    }

    // Unknown format, pass through for visibility and downstream handling.
    addLog("Remote read timestamp format not recognized for normalization, using as-is: " + raw, "warning");
    return raw;
}

/**
 * Derives the remote read timestamp from mirrored source rows.
 *
 * Query scope:
 * - x_tieoy_eus_device_row
 * - integration_customer = integrationGR.sys_id
 * - data_source = 3stepit
 *
 * Fallback order:
 * 1) Latest custom_1 (raw ISO changetime) from mirrored rows (orderByDesc, lexicographic)
 * 2) remote_read_timestamp_seed from config
 * 3) empty string (full fetch)
 *
 * Note: custom_1 is used instead of source_updated to avoid timezone skew. source_updated is
 * a GlideDateTime field and ServiceNow stores it in the session user's timezone when set via
 * direct assignment, causing the watermark to be offset by the user's UTC offset (e.g. EET = UTC+3).
 * custom_1 holds the raw API changetime string (ISO UTC) which is timezone-safe and lexicographically
 * sortable.
 *
 * @param {GlideRecord} integrationGR u_integration_customer record.
 * @param {String} seed Fallback seed from config.
 * @returns {String} Remote read timestamp string.
 */
function getRemoteReadTimestampFromDeviceRows(integrationGR, seed) {
    try {
        var rowGR = new GlideRecord("x_tieoy_eus_device_row");
        rowGR.addQuery("integration_customer", integrationGR.getUniqueValue());
        rowGR.addQuery("data_source", "3stepit");
        rowGR.addNotNullQuery("custom_1");
        rowGR.orderByDesc("custom_1");
        rowGR.setLimit(1);
        rowGR.query();

        if (rowGR.next()) {
            var latestChangetime = String(rowGR.getValue("custom_1") || "");
            if (latestChangetime) {
                addLog("Remote read timestamp from device rows (latest custom_1 changetime): " + latestChangetime);
                return latestChangetime;
            }
        }
    } catch (aggErr) {
        addLog("Could not derive remote read timestamp from device rows: " + aggErr.message, "warning");
    }

    if (seed) {
        addLog("No device-row custom_1 timestamp found. Using remote_read_timestamp_seed: " + seed, "warning");
        return seed;
    }

    addLog("No device-row custom_1 timestamp and no remote_read_timestamp_seed. Fetching all available assets.", "warning");
    return "";
}


/**
 * Fetches 3StepIT assets from service endpoint.
 *
 * Return contract:
 * - [] for no data
 * - Array for success
 * - null for fatal fetch failure
 * - Assets are sorted by changetime ascending before limiting.
 * - Processing is capped to MAX_READ_RECORDS per run.
 *
 * @param {String} serviceEndpoint Asset API endpoint URL.
 * @param {String} token Bearer token.
 * @param {String} apiKey API key for x-api-key header.
 * @param {Object} queryParams Request query parameters.
 * @param {Object} [metricsObj] Optional output metrics object; receives queryMs.
 * @returns {Array|null} Normalized asset array or null on failure.
 */
function fetchAssets(serviceEndpoint, token, apiKey, queryParams, metricsObj) {
    try {
        var fetchRequest = new sn_ws.RESTMessageV2();
        fetchRequest.setEndpoint(serviceEndpoint);
        fetchRequest.setHttpMethod("get");
        fetchRequest.setRequestHeader("Accept", "application/json");
        fetchRequest.setRequestHeader("Authorization", "Bearer " + token);
        fetchRequest.setRequestHeader("x-api-key", apiKey);
        fetchRequest.setHttpTimeout(30000);

        for (var key in queryParams) {
            if (queryParams.hasOwnProperty(key)) {
                fetchRequest.setQueryParameter(key, String(queryParams[key]));
            }
        }
        addLog("Asset request endpoint: " + fetchRequest.getEndpoint() + "?" + Object.keys(queryParams).map(k => k + "=" + queryParams[k]).join("&"), "debug");

        addLog("Fetching assets from 3StepIT");
        
        
        var queryStartedMs = new Date().getTime();
        var fetchResponse = fetchRequest.execute();
        var queryElapsedMs = new Date().getTime() - queryStartedMs;
        if (metricsObj && typeof metricsObj === "object") {
            metricsObj.queryMs = queryElapsedMs;
        }
        addLog("Asset query took " + queryElapsedMs + " ms");
        var statusCode = fetchResponse.getStatusCode();
        var body = fetchResponse.getBody();

        if (statusCode === 204) {
            addLog("Asset API returned 204 (no content)");
            return [];
        }

        if (statusCode < 200 || statusCode > 299) {
            addLog("Asset request failed with HTTP " + statusCode + (body ? " body=" + body : ""), "error");
            return null;
        }

        if (!body) {
            addLog("Asset response body was empty");
            return [];
        }

        var payload = JSON.parse(body);
        var assets = sortAssetsByChangetime(normalizeAssetArray(payload));
        if (assets.length > MAX_READ_RECORDS) {
            addLog("Asset fetch returned " + assets.length + " records, limiting processing to " + MAX_READ_RECORDS + " this run", "info");
            assets = assets.slice(0, MAX_READ_RECORDS);
        }
        addLog("Fetched asset count: " + assets.length);
        if (assets.length === 0) {
            addLog("No assets found, response payload: " + body);
        }
        return assets;
    } catch (e) {
        addLog("Asset fetch exception: " + e.message, "error");
        return null;
    }
}

/**
 * Syncs changed local workstation CIs to remote endpoint via one-device PUT requests.
 *
 * Behavior:
 * - Uses local_query_filter as base encoded query.
 * - Uses compound local cursor encoded in u_poller_cursor as "timestamp|sys_id".
 * - Reads in deterministic two-phase order with MAX_WRITE_RECORDS cap:
 *   1) same-second continuation (sys_updated_on = ts and sys_id > cursor_sys_id)
 *   2) newer seconds (sys_updated_on > ts)
 * - Skips write sync when local read timestamp is empty (first-run behavior).
 * - On local query failure, logs error and does nothing further.
 * - Persists updated compound cursor after processing candidates in this run.
 *
 * @param {GlideRecord} integrationGR u_integration_customer record.
 * @param {String} serviceEndpoint Target endpoint URL for PUT.
 * @param {String} token Bearer token.
 * @param {String} apiKey API key for x-api-key header.
 * @param {String} localQueryFilter Base encoded query for cmdb_ci_workstation_pc.
 * @param {String} localReadTimestampOverride Optional local read timestamp override from u_config.
 * @param {String} localReadTimestampSeed Optional first-run local read timestamp seed from u_config.
 * @returns {Object} Write metrics: candidates, sent, success, deviceNotFound, failed, skipped.
 */
function syncLocalChangesToRemote(integrationGR, serviceEndpoint, token, apiKey, localQueryFilter, localReadTimestampOverride, localReadTimestampSeed) {
    var metrics = {
        candidates: 0,
        sent: 0,
        success: 0,
        deviceNotFound: 0,
        deviceEnded: 0,
        deviceDuplicate: 0,
        deviceDupeRetryOk: 0,
        deviceDupeRetryFail: 0,
        failed: 0,
        skipped: 0
    };

    if (!localQueryFilter) {
        addLog("Missing local_query_filter in integration u_config. Skipping local write sync.", "error");
        metrics.skipped++;
        return metrics;
    }

    function parseLocalReadCursor(cursorValueRaw) {
        var cursorValue = String(cursorValueRaw || "").trim();
        if (!cursorValue) {
            return {
                timestamp: "",
                sysId: ""
            };
        }

        var separatorIndex = cursorValue.indexOf("|");
        if (separatorIndex < 0) {
            return {
                timestamp: cursorValue,
                sysId: ""
            };
        }

        return {
            timestamp: cursorValue.substring(0, separatorIndex),
            sysId: cursorValue.substring(separatorIndex + 1)
        };
    }

    function buildLocalReadCursor(cursorTimestamp, cursorSysId) {
        if (!cursorTimestamp) {
            return "";
        }
        if (!cursorSysId) {
            return String(cursorTimestamp);
        }
        return String(cursorTimestamp) + "|" + String(cursorSysId);
    }

    var localReadTimestamp = "";
    var localReadCursorSysId = "";
    if (localReadTimestampOverride) {
        localReadTimestamp = String(localReadTimestampOverride);
        addLog("Using local_read_timestamp override from config: " + localReadTimestamp, "info");
        addLog("Ignoring encoded local cursor sys_id because local_read_timestamp override is active", "info");
    } else {
        var rawCursor = String(integrationGR.getValue("u_poller_cursor") || "").trim();
        var parsedCursor = parseLocalReadCursor(rawCursor);
        localReadTimestamp = parsedCursor.timestamp;
        localReadCursorSysId = parsedCursor.sysId;
        if (!localReadTimestamp) {
            if (!localReadTimestampSeed) {
                addLog("Local read cursor (u_poller_cursor) is empty and no local_read_timestamp_seed provided. Skipping local write sync.", "info");
                metrics.skipped++;
                return metrics;
            }
            localReadTimestamp = String(localReadTimestampSeed);
            localReadCursorSysId = "";
            addLog("Using local_read_timestamp_seed from config: " + localReadTimestamp, "info");
        }
    }

    addLog("Local read cursor: " + localReadTimestamp + "|" + (localReadCursorSysId || "<none>"), "debug");
    addLog("Limiting local write sync to " + MAX_WRITE_RECORDS + " records this run", "debug");

    var remainingWriteBudget = MAX_WRITE_RECORDS;
    var lastProcessedLocalReadTimestamp = localReadTimestamp;
    var lastProcessedLocalReadSysId = localReadCursorSysId;
    var topCompany = String(integrationGR.u_company.u_top_company.getDisplayValue() || "");

    function processCiBatch(ciGR, phaseLabel) {
        var processedInPhase = 0;
        while (remainingWriteBudget > 0 && ciGR.next()) {
            metrics.candidates++;
            processedInPhase++;
            remainingWriteBudget--;
            lastProcessedLocalReadTimestamp = String(ciGR.getValue("sys_updated_on") || lastProcessedLocalReadTimestamp || "");
            lastProcessedLocalReadSysId = String(ciGR.getUniqueValue() || lastProcessedLocalReadSysId || "");

            var ciIdentifier = String(ciGR.getValue("serial_number") || ciGR.getUniqueValue());
            var remoteDevice;
            try {
                remoteDevice = mapCiToRemoteDevice(ciGR, topCompany);
            } catch (mapErr) {
                metrics.failed++;
                addLog("CI mapping failed for " + ciIdentifier + ": " + mapErr.message, "error");
                continue;
            }

            metrics.sent++;
            addLog("PUT outbound payload for " + ciIdentifier + ":\n" + JSON.stringify(remoteDevice, null, 2), "debug");
            var putResult = putDeviceToRemote(serviceEndpoint, token, apiKey, remoteDevice);
            if (putResult.ok) {
                metrics.success++;
                addLog("PUT succeeded for " + ciIdentifier + ": " + putResult.message);
            } else if (putResult.message && String(putResult.message).indexOf("DEVICE_NOT_FOUND:") === 0) {
                metrics.deviceNotFound++;
                addLog("DEVICE_NOT_FOUND - PUT skipped for " + ciIdentifier + ": " + putResult.message);
            } else if (putResult.message && String(putResult.message).indexOf("DEVICE_ENDED:") === 0) {
                metrics.deviceEnded++;
                addLog("DEVICE_ENDED - PUT skipped for " + ciIdentifier + ": " + putResult.message);
            } else if (putResult.message && String(putResult.message).indexOf("DEVICE_DUPLICATE:") === 0) {
                metrics.deviceDuplicate++;
                var dupeCorrelationId = String(ciGR.getValue("correlation_id") || "");
                if (dupeCorrelationId) {
                    // Retry with devicenumber as key — 3StepIT may have copied the asset to another devicenumber
                    var retryDevice = {};
                    for (var retryKey in remoteDevice) {
                        if (remoteDevice.hasOwnProperty(retryKey)) {
                            retryDevice[retryKey] = remoteDevice[retryKey];
                        }
                    }
                    retryDevice.keycolumn = 'devicenumber';
                    retryDevice.devicenumber = dupeCorrelationId;
                    addLog("DEVICE_DUPLICATE - retrying PUT for " + ciIdentifier + " with keycolumn=devicenumber (" + dupeCorrelationId + ")", "debug");
                    var dupeRetryResult = putDeviceToRemote(serviceEndpoint, token, apiKey, retryDevice);
                    if (dupeRetryResult.ok) {
                        metrics.deviceDupeRetryOk++;
                        addLog("DEVICE_DUPLICATE retry succeeded for " + ciIdentifier + ": " + dupeRetryResult.message);
                    } else {
                        metrics.deviceDupeRetryFail++;
                        addLog("DEVICE_DUPLICATE retry failed for " + ciIdentifier + ": " + dupeRetryResult.message, "warning");
                    }
                } else {
                    addLog("DEVICE_DUPLICATE - no correlation_id for retry, PUT skipped for " + ciIdentifier + ": " + putResult.message, "info");
                }
            } else {
                metrics.failed++;
                if (putResult.message && String(putResult.message).indexOf("PERMISSION_ERROR:") === 0) {
                    addLog("PERMISSION_ISSUE - PUT failed for " + ciIdentifier + ": " + putResult.message, "info"); // Temporarily muting warnings from this 
                } else {
                    addLog("PUT failed for " + ciIdentifier + ": " + putResult.message, "warning"); // 
                }
            }
        }

        if (processedInPhase > 0) {
            addLog("Local phase " + phaseLabel + " processed " + processedInPhase + " rows (remaining budget=" + remainingWriteBudget + ")", "debug");
        }
    }

    try {
        if (localReadCursorSysId && remainingWriteBudget > 0) {
            var sameSecondGR = new GlideRecord("cmdb_ci_workstation_pc");
            sameSecondGR.addQuery("company.u_top_company", integrationGR.u_company.u_top_company);
            sameSecondGR.addEncodedQuery(localQueryFilter);
            sameSecondGR.addQuery("sys_updated_on", localReadTimestamp);
            sameSecondGR.addQuery("sys_id", ">", localReadCursorSysId);
            sameSecondGR.orderBy("sys_updated_on");
            sameSecondGR.orderBy("sys_id");
            sameSecondGR.setLimit(remainingWriteBudget);
            addLog("Local query for changed CIs (same-second continuation): " + sameSecondGR.getEncodedQuery(), "debug");
            sameSecondGR.query();
            processCiBatch(sameSecondGR, "same-second");
        }

        if (remainingWriteBudget > 0) {
            var newerSecondGR = new GlideRecord("cmdb_ci_workstation_pc");
            newerSecondGR.addQuery("company.u_top_company", integrationGR.u_company.u_top_company);
            newerSecondGR.addEncodedQuery(localQueryFilter);
            newerSecondGR.addQuery("sys_updated_on", ">", localReadTimestamp);
            newerSecondGR.orderBy("sys_updated_on");
            newerSecondGR.orderBy("sys_id");
            newerSecondGR.setLimit(remainingWriteBudget);
            addLog("Local query for changed CIs (newer-seconds): " + newerSecondGR.getEncodedQuery(), "debug");
            newerSecondGR.query();
            processCiBatch(newerSecondGR, "newer-seconds");
        }

        if (metrics.candidates > 0) {
            var previousWatermarkValue = String(integrationGR.getValue("u_poller_cursor") || "").trim();
            var newWatermarkValue = buildLocalReadCursor(lastProcessedLocalReadTimestamp, lastProcessedLocalReadSysId);

            if (newWatermarkValue && newWatermarkValue !== previousWatermarkValue) {
                integrationGR.setValue("u_poller_cursor", newWatermarkValue);
                integrationGR.update();
                addLog("Local read cursor updated to: " + String(integrationGR.getValue("u_poller_cursor")), "debug");
            } else {
                addLog("Local read cursor unchanged", "debug");
            }
        } else {
            addLog("No local CI candidates found. Local read cursor unchanged", "debug");
        }
    } catch (queryErr) {
        metrics.skipped++;
        addLog("Local query failure. Write sync skipped: " + queryErr.message, "error");
    }

    return metrics;
}

/**
 * Sends one local workstation CI payload as PUT to remote endpoint.
 *
 * Success criteria:
 * - HTTP status is exactly 200
 * - JSON response contains result equal to "updated"
 *
 * Retry policy:
 * - HTTP 0 (transport error / timeout) triggers automatic retry up to maxRetries times with a 2-second sleep.
 * - HTTP 429 (rate limit) triggers automatic retry up to maxRetries times with a 4-second sleep.
 * - Permission errors (no right to update columns) are detected and returned immediately without retry.
 *
 * @param {String} serviceEndpoint Target endpoint URL.
 * @param {String} token Bearer token.
 * @param {String} apiKey API key for x-api-key header.
 * @param {Object} deviceObj Single mapped device payload.
 * @param {Number} [maxRetries=3] Maximum retry attempts for HTTP 0 and HTTP 429.
 * @returns {Object} Result object: { ok: Boolean, message: String }.
 */
function putDeviceToRemote(serviceEndpoint, token, apiKey, deviceObj, maxRetries) {
    if (typeof maxRetries === "undefined") {
        maxRetries = 3;
    }

    var result = {
        ok: false,
        message: ""
    };
    var deviceSerial = String(deviceObj.serialnumber || "unknown");

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            var putRequest = new sn_ws.RESTMessageV2();
            putRequest.setEndpoint(serviceEndpoint);
            putRequest.setHttpMethod("put");
            putRequest.setRequestHeader("Accept", "application/json");
            putRequest.setRequestHeader("Content-Type", "application/json");
            putRequest.setRequestHeader("Authorization", "Bearer " + token);
            putRequest.setRequestHeader("x-api-key", apiKey);
            putRequest.setHttpTimeout(30000);

            var payload = {
                devices: [deviceObj]
            };
            putRequest.setRequestBody(JSON.stringify(payload));

            var putResponse = putRequest.execute();
            var statusCode = putResponse.getStatusCode();
            var responseBody = putResponse.getBody();

            // Handle HTTP 0 (transport error / timeout) with retry
            if (statusCode === 0) {
                if (attempt < maxRetries) {
                    addLog("Retrying PUT for " + deviceSerial + ": attempt " + attempt + "/" + maxRetries + " (HTTP 0 — timeout/transport error)", "warning");
                    appHelper.sleep(2000);
                    continue;
                }
                result.message = "HTTP 0 (timeout/transport error)";
                return result;
            }

            // Handle HTTP 429 (rate limit) with retry
            if (statusCode === 429) {
                if (attempt < maxRetries) {
                    addLog("Retrying PUT for " + deviceSerial + ": attempt " + attempt + "/" + maxRetries + " (HTTP 429)", "warning");
                    appHelper.sleep(4000);
                    continue; // Retry the loop
                }
                // After all retries exhausted
                result.message = "HTTP " + statusCode + (responseBody ? " body=" + responseBody : "");
                addLog("PUT response [" + statusCode + "] for " + deviceSerial + ": " + (responseBody || "<empty>"), "debug");
                return result;
            }

            // Non-200 status codes (except 0 and 429 which are handled above) are not retried
            if (statusCode !== 200) {
                result.message = "HTTP " + statusCode + (responseBody ? " body=" + responseBody : "");
                addLog("PUT response [" + statusCode + "] for " + deviceSerial + ": " + (responseBody || "<empty>"), "debug");
                return result;
            }

            var responseObj;
            try {
                responseObj = JSON.parse(responseBody || "{}");
            } catch (parseErr) {
                result.message = "response parse error: " + parseErr.message;
                return result;
            }

            addLog("PUT response: " + responseBody, "debug");

            var responseResultRaw = "";
            if (responseObj.devices && Array.isArray(responseObj.devices) && responseObj.devices.length > 0) {
                responseResultRaw = String(responseObj.devices[0].result || "");
            } else {
                responseResultRaw = String(responseObj.result || "");
            }
            var responseResultNormalized = String(responseResultRaw || "").toLowerCase();

            // Detect permission errors
            if (responseResultNormalized.indexOf("no right to update columns") >= 0) {
                result.message = "PERMISSION_ERROR: " + responseResultRaw;
                return result;
            }

            // Treat device-not-found as a non-fatal deferred case for separate retry routine
            if (responseResultNormalized.indexOf("device not found") >= 0 || responseResultNormalized.indexOf("no device found") >= 0) {
                result.message = "DEVICE_NOT_FOUND: " + responseResultRaw;
                return result;
            }

            // Treat ended devices as non-fatal — no updates allowed once a device has ended
            if (responseResultNormalized.indexOf("device ended") >= 0) {
                result.message = "DEVICE_ENDED: " + responseResultRaw;
                return result;
            }

            // Treat duplicate serial (copied to multiple device numbers) as non-fatal — provider-side data issue
            if (responseResultNormalized.indexOf("updating multiple devices at once is not allowed") >= 0) {
                result.message = "DEVICE_DUPLICATE: " + responseResultRaw;
                return result;
            }

            var responseResult = responseResultNormalized;
            if (responseResult === "updated") {
                result.ok = true;
                result.message = responseResultRaw;
                if (attempt > 1) {
                    addLog("PUT succeeded for " + deviceSerial + " on attempt " + attempt + "/" + maxRetries + ": " + responseResultRaw, "debug");
                }
                return result;
            }

            result.message = "result was '" + responseResultRaw + "'";
            return result;
        } catch (e) {
            result.message = "exception: " + e.message;
            return result;
        }
    }

    return result;
}

/**
 * Maps one workstation CI record to one remote device object for PUT payload.
 *
 * Builds a default payload (L&T mapping) first, then applies customer-specific
 * overrides when topCompany matches a known customer.
 *
 * Default mapping (all customers unless overridden):
 * - keycolumn   <- "serialnumber" (literal)
 * - serialnumber <- serial_number
 * - idnumber    <- name
 * - username    <- managed_by DV, fallback assigned_to DV (AnonymUser suppressed)
 * - costcenter  <- u_customer_invoicing_ref_1
 * - location    <- location DV
 * - extrainfo   <- company DV
 * - extradate5  <- date part of sys_updated_on (yyyy-MM-dd); triggers remote ping-back
 *
 * Tampere Region overrides (topCompany === "Tampere Region"):
 * - idnumber    <- asset_tag
 * - username    <- first line of short_description, fallback assigned_to DV
 * - costcenter  <- "Tieto Finland Oy" if u_device_tag contains "tieto" (case-insensitive), else company DV
 * - location    <- location DV with trailing country code "; XX" stripped
 * - extrainfo   <- (removed)
 * - costcenter2 <- u_customer_invoicing_ref_2
 * - versionother <- u_customer_invoicing_ref_1
 * - extranumber5 <- install_status
 * - extratext2  <- u_exact_location
 *
 * @param {GlideRecord} ciGR cmdb_ci_workstation_pc record.
 * @param {String} topCompany Display value of integrationGR.u_company.u_top_company.
 * @returns {Object} One device object for payload.devices[0].
 * @throws {Error} When required serial_number is missing.
 */
function mapCiToRemoteDevice(ciGR, topCompany) {
    var serialNumber = String(ciGR.getValue("serial_number") || "").trim();
    if (!serialNumber) {
        throw new Error("CI missing serial_number");
    }

    // extradate5: date part only from sys_updated_on (all customers).
    // Causes update on the remote system, so we get a ping-back and data refreshed to our system too.
    var sysUpdatedRaw = String(ciGR.getDisplayValue("sys_updated_on") || "");
    var extradate5Match = sysUpdatedRaw.match(/\d{4}-\d\d-\d\d/);
    var extradate5 = extradate5Match ? extradate5Match[0] : "";

    // Default username: managed_by (Discovered user) falling back to assigned_to.
    // AnonymUser values are treated as empty for both fields.
    var username = String(ciGR.getDisplayValue("managed_by") || "");
    if (username.match(/AnonymUser/i)) {
        username = "";
    }
    if (!username) {
        username = String(ciGR.getDisplayValue("assigned_to") || "");
        if (username.match(/AnonymUser/i)) {
            username = "";
        }
    }

    var companyName = String(ciGR.getDisplayValue("company") || "").trim();
    if (/^luotea fs$/i.test(companyName)) {
        companyName = "LUOTEA";
    }

    // Default (L&T) payload
    var device = {
        keycolumn: 'serialnumber',
        serialnumber: serialNumber,
        idnumber: String(ciGR.getValue('name') || ""),
        username: username,
        costcenter: String(ciGR.getValue("u_customer_invoicing_ref_1") || ""),
        location: String(ciGR.getDisplayValue("location") || ""),
        extrainfo: companyName,
        extradate5: extradate5
    };

    // Tampere Region overrides
    if (topCompany === "Tampere Region") {
        // idnumber: asset_tag instead of name
        device.idnumber = String(ciGR.getValue('asset_tag') || "");

        // username: first line of short_description if present, else assigned_to DV
        var shortDesc = String(ciGR.getValue("short_description") || "").trim();
        var firstLine = shortDesc ? shortDesc.split("\n")[0].trim() : "";
        device.username = firstLine || String(ciGR.getDisplayValue("assigned_to") || "");

        // costcenter: "Tieto Finland Oy" if u_device_tag contains "tieto", else company DV
        var deviceTag = String(ciGR.getValue("u_device_tag") || "");
        device.costcenter = /tieto/i.test(deviceTag) ?
            "Tieto Finland Oy" :
            String(ciGR.getDisplayValue("company") || "");

        // location: strip trailing country code "; FI"
        var locationRaw = String(ciGR.getDisplayValue("location") || "");
        var locationMatch = locationRaw.match(/(.*);[ ]?\S{2}$/);
        device.location = locationMatch ? locationMatch[1].trim() : locationRaw;

        // extrainfo not used for TRE
        delete device.extrainfo;

        // TRE-only fields
        device.costcenter2 = String(ciGR.getValue("u_customer_invoicing_ref_2") || "");
        device.versionother = String(ciGR.getValue("u_customer_invoicing_ref_1") || "");
        device.extranumber5 = String(ciGR.getValue("install_status") || "");
        device.extratext2 = String(ciGR.getValue("u_exact_location") || "");
    }

    return device;
}

/**
 * Mirrors one incoming 3StepIT asset into x_tieoy_eus_device_row for source tracking.
 *
 * Key model (upsert):
 * - top_company
 * - data_source = 3stepit
 * - source_id = devicenumber (preferred) or serialnumber (fallback when devicenumber absent)
 *
 * Migration: existing rows stored under source_id=serialnumber are located by a second lookup
 * and their source_id is updated to devicenumber on the fly. Requires devicenumber to be
 * included in remote_query_params.columns; if absent, serialnumber is used throughout.
 *
 * @param {GlideRecord} integrationGR u_integration_customer record.
 * @param {Object} assetObj Incoming 3StepIT asset object.
 * @returns {Object} Upsert summary: { inserted: Boolean, changed: Boolean, rowSysId: String }.
 */
function hasMeaningfulRowChanges(rowGR, fieldsToSkip) {
    var elements = rowGR.getElements();
    var skipMap = {};
    for (var i = 0; i < fieldsToSkip.length; i++) {
        skipMap[String(fieldsToSkip[i])] = true;
    }

    for (var j = 0; j < elements.length; j++) {
        var element = elements[j];
        var fieldName = String(element.getName());
        if (!skipMap[fieldName] && element.changes()) {
            return true;
        }
    }

    return false;
}

function upsert3StepitSourceRow(integrationGR, assetObj) {
    var serialNumber = String(assetObj.serialnumber || "").trim();
    if (!serialNumber) {
        throw new Error("Asset missing serialnumber for source row copy");
    }

    // devicenumber is the preferred source_id key — it is unique per device record in 3StepIT
    // and avoids ambiguity when a serial resolves to multiple devicenumbers (DEVICE_DUPLICATE case).
    // Requires devicenumber to be present in remote_query_params.columns; falls back to serialnumber
    // when the field is absent from the API response.
    var deviceNumber = String(assetObj.devicenumber || "").trim();
    var sourceId = deviceNumber || serialNumber;

    var rowGR = new GlideRecord("x_tieoy_eus_device_row");
    rowGR.addQuery("top_company", integrationGR.u_company.u_top_company);
    rowGR.addQuery("data_source", "3stepit");
    rowGR.addQuery("source_id", sourceId);
    rowGR.setLimit(1);
    rowGR.query();
    var isInsert = false;

    if (!rowGR.next()) {
        if (deviceNumber) {
            // Not found by devicenumber — check for a legacy row stored under serialnumber (26k existing records).
            var legacyRowGR = new GlideRecord("x_tieoy_eus_device_row");
            legacyRowGR.addQuery("top_company", integrationGR.u_company.u_top_company);
            legacyRowGR.addQuery("data_source", "3stepit");
            legacyRowGR.addQuery("source_id", serialNumber);
            legacyRowGR.setLimit(1);
            legacyRowGR.query();
            if (legacyRowGR.next()) {
                rowGR = legacyRowGR;
                // Migrate source_id from serialnumber to devicenumber on next save.
                rowGR.source_id = deviceNumber;
                addLog("source_id migrated from serial to devicenumber for " + serialNumber + " -> " + deviceNumber, "debug");
            } else {
                rowGR.initialize();
                isInsert = true;
                rowGR.top_company = integrationGR.u_company.u_top_company;
                rowGR.sys_domain = integrationGR.u_company.sys_domain;
                rowGR.data_source = "3stepit";
                rowGR.source_id = deviceNumber;
            }
        } else {
            rowGR.initialize();
            isInsert = true;
            rowGR.top_company = integrationGR.u_company.u_top_company;
            rowGR.sys_domain = integrationGR.u_company.sys_domain;
            rowGR.data_source = "3stepit";
            rowGR.source_id = serialNumber;
        }
    }

    rowGR.serial_number = serialNumber;
    rowGR.source_status = String(assetObj.publicstatus);
    rowGR.source_updated = normalizeSourceUpdatedForSn(assetObj.changetime);
    rowGR.custom_1 = String(assetObj.changetime || ""); // preserve original changetime for visibility since source_updated is normalized
    rowGR.last_seen = new GlideDateTime();
    rowGR.integration_customer = integrationGR.sys_id;
    rowGR.name = serialNumber;
    rowGR.source_json = JSON.stringify(assetObj, "", 2);
    rowGR.user_text = String(assetObj.username);
    rowGR.model_name = String(assetObj.name);
    var hasChanged = isInsert;
    if (!isInsert) {
        // feed with an array of fields to skip for change detection:
        hasChanged = hasMeaningfulRowChanges(rowGR, ["sys_updated_on", "source_updated", "last_seen"]);
    }

    if (isInsert) {
        rowGR.insert();
    } else {
        rowGR.update();
    }

    return {
        inserted: isInsert,
        changed: hasChanged,
        rowSysId: String(rowGR.getUniqueValue() || "")
    };
}

/**
 * Normalizes API response payload into a plain asset array.
 *
 * Supported payload shapes:
 * - [ ... ]
 * - { result: [ ... ] }
 * - { data: [ ... ] }
 * - { items: [ ... ] }
 * - { devices: [ ... ] }
 *
 * @param {*} payload Parsed JSON payload from API response.
 * @returns {Array} Asset array (empty when shape is not recognized).
 */
function normalizeAssetArray(payload) {
    if (!payload) {
        return [];
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    if (payload.result && Array.isArray(payload.result)) {
        return payload.result;
    }
    if (payload.data && Array.isArray(payload.data)) {
        return payload.data;
    }
    if (payload.items && Array.isArray(payload.items)) {
        return payload.items;
    }
    if (payload.devices && Array.isArray(payload.devices)) {
        return payload.devices;
    }
    return [];
}

/**
 * Converts remote changetime to ServiceNow internal datetime format.
 *
 * Input can be ISO (e.g. 2026-04-13T21:00:00Z) or already in
 * ServiceNow format (yyyy-MM-dd HH:mm:ss).
 *
 * @param {String} sourceUpdatedRaw Raw source changetime value.
 * @returns {String} ServiceNow datetime string in UTC internal format.
 */
function normalizeSourceUpdatedForSn(sourceUpdatedRaw) {
    var raw = String(sourceUpdatedRaw || "").trim();
    if (!raw) {
        return "";
    }

    // Already ServiceNow internal datetime format.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
        return raw;
    }

    // ISO UTC: yyyy-MM-ddTHH:mm:ss(.SSS)Z -> yyyy-MM-dd HH:mm:ss
    var isoUtcMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(raw);
    if (isoUtcMatch) {
        return isoUtcMatch[1] + " " + isoUtcMatch[2];
    }

    // ISO with offset: yyyy-MM-ddTHH:mm:ss(.SSS)+HH:mm / -HH:mm
    // Let GlideDateTime handle timezone shift after we remove fractional part.
    var isoOffsetMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})$/.exec(raw);
    if (isoOffsetMatch) {
        raw = isoOffsetMatch[1] + isoOffsetMatch[2];
    }

    try {
        var gdt = new GlideDateTime(raw);
        return gdt.getValue();
    } catch (dtErr) {
        addLog("Could not normalize source_updated value to SN datetime, using raw value: " + raw, "warning");
        return raw;
    }
}

/**
 * Sorts asset array by changetime ascending before processing/limiting.
 *
 * Assets with missing changetime are pushed to the end.
 *
 * @param {Array} assets Asset array from API response.
 * @returns {Array} Sorted shallow copy of asset array.
 */
function sortAssetsByChangetime(assets) {
    if (!Array.isArray(assets) || assets.length < 2) {
        return assets || [];
    }

    return assets.slice(0).sort(function(leftAsset, rightAsset) {
        var leftChangeTime = String((leftAsset && leftAsset.changetime) || "");
        var rightChangeTime = String((rightAsset && rightAsset.changetime) || "");

        if (!leftChangeTime && !rightChangeTime) {
            return 0;
        }
        if (!leftChangeTime) {
            return 1;
        }
        if (!rightChangeTime) {
            return -1;
        }
        if (leftChangeTime < rightChangeTime) {
            return -1;
        }
        if (leftChangeTime > rightChangeTime) {
            return 1;
        }
        return 0;
    });
}

/**
 * Inserts one mapped import row into u_3stepit_asset_row.
 *
 * Safety behavior:
 * - Only fields existing on target table are set.
 * - Unknown fields in rowObj are ignored.
 *
 * @param {Object} rowObj Mapped import row object.
 * @returns {String} sys_target_sys_id from the matched import row after synchronous transform, or empty string when CI not matched.
 */
function insertImportRow(rowObj) {
    var importGR = new GlideRecord("u_3stepit_asset_row");
    importGR.initialize();

    for (var key in rowObj) {
        if (rowObj.hasOwnProperty(key) && importGR.isValidField(key)) {
            importGR.setValue(key, rowObj[key]);
        }
    }

    // importGR.insert(); // fails, use appHelper instead.
    // Capture returned sys_id to re-fetch after the synchronous transform has run and set sys_target_sys_id.
    var insertedId = String(appHelper.insertGlideRecord(importGR) || "");
    if (insertedId) {
        importGR.addQuery("sys_id", insertedId);
        appHelper.queryGlideRecord(importGR);
        if (importGR.next()) {
            return String(importGR.getValue("sys_target_sys_id") || "");
        }
    } else {
        // Fallback: appHelper.insertGlideRecord() returned null/undefined — re-query by serial + integration.
        var fallbackGR = new GlideRecord("u_3stepit_asset_row");
        fallbackGR.addQuery("u_serial_number", String(rowObj.u_serial_number || ""));
        fallbackGR.addQuery("u_integration_customer", String(rowObj.u_integration_customer || ""));
        fallbackGR.orderByDesc("sys_created_on");
        fallbackGR.setLimit(1);
        appHelper.queryGlideRecord(fallbackGR);
        if (fallbackGR.next()) {
            return String(fallbackGR.getValue("sys_target_sys_id") || "");
        }
        return "";
    }
    return String(importGR.getValue("sys_target_sys_id") || "");
}

/**
 * Maps 3StepIT asset fields to u_3stepit_asset_row import row payload.
 * Field mappings extracted from ONEiO Routing Rules (3StepIt L&T Polling - Tieto).
 * Sets u_top_company_name from integrationGR.u_company.u_top_company_name.
 *
 * Extension guidance:
 * - Add new mappings here as `u_target_field: String(assetObj.sourcefield || "")`.
 * - Keep serialnumber validation intact (required key for downstream processing).
 * - Prefer preserving source payload in u_source_payload for traceability.
 *
 * @param {Object} assetObj One asset object from 3StepIT API response.
 * @param {String} integrationId Sys_id of u_integration_customer record.
 * @param {String} topCompanyName Top company display name from integration record.
 * @returns {Object} Plain object ready for insertImportRow().
 * @throws {Error} When required source field serialnumber is missing.
 */
function mapAssetToImportRow(assetObj, integrationId, topCompanyName) {
    var serialNumber = String(assetObj.serialnumber || "").trim();
    if (!serialNumber) {
        throw new Error("Asset missing serialnumber");
    }

    // Build mapping object with all fields from ONEiO routing rules
    var row = {
        u_integration_customer: integrationId,
        u_serial_number: serialNumber,
        u_source_change_time: String(assetObj.changetime || ""),
        u_source_payload: JSON.stringify(assetObj),

        // ONEiO routing rule mappings: source field -> target attribute
        u_device: String(assetObj.devicenumber || ""),
        u_3stepit_asset_row: String(assetObj.productgroup || ""),
        u_device_name: String(assetObj.name || ""),
        u_user_name: String(assetObj.username || ""),
        u_location: String(assetObj.location || ""),
        u_cost_centre: String(assetObj.costcenter || ""),
        u_version_other: String(assetObj.versionother || ""),
        u_contract_number: String(assetObj.contractnumber || ""),
        u_end_date: String(assetObj.enddate || ""),
        u_start_date: String(assetObj.startdate || ""),
        u_cost_centre_2: String(assetObj.costcenter2 || ""),
        u_signing_date: String(assetObj.signingdate || ""),
        u_order_reference: String(assetObj.orderreference || ""),
        u_id_number: String(assetObj.idnumber || ""),
        u_original_start_date: String(assetObj.originalstartdate || ""),
        u_device_age: String(assetObj.currentage || ""), // 2026-08-13: currentage added to remote_query_params in PROD
        u_rent: String(assetObj.rent || ""),
        u_purchase_option_price: String(assetObj.purchaseoptionprice || ""),
        u_purchase_price: String(assetObj.purchaseprice || ""),
        u_status: String(assetObj.publicstatus || ""),
        u_ending_option: String(assetObj.endingoptionid || ""),
        u_ending_option_info: String(assetObj.endingoption || ""), // Not really needed, good for debug
        u_ending: String(assetObj.ending || ""), // 0 = active, 1 = ending; not used currently - dropped
        u_received_date: String(assetObj.receiveddate || ""), // key identifier for all devices to mark them as "Retired" in Lifecycle
        u_financial_type: String(assetObj.financialtype || ""), // Dropped from query
        u_extra_info: String(assetObj.extrainfo || ""), // used in PIRHA carve out, seems to contain MASS order numbers in TRE
        u_project: String(assetObj.extratext1 || ""), // used in L&T/Luotea for the "shipping" to user info by OSS
        u_company_product_group: String(assetObj.companyproductgroup || ""), // now dropped, was used L&T Luoeta carve out
        u_product_group: String(assetObj.productgroup || ""), // used by the coalesce script
        u_device_supplier: String(assetObj.devicesupplier || ""), // Foxway, etc -- used in Tampere logic at least
        u_top_company_name: String(topCompanyName || "")
    };

    return row;
}

/**
 * Compares two ISO-like datetime strings.
 *
 * Intended for watermark advancement where values are in sortable ISO format.
 *
 * @param {String} candidate Candidate changetime.
 * @param {String} baseline Current best changetime.
 * @returns {Boolean} True when candidate is later than baseline.
 */
function isIsoLater(candidate, baseline) {
    if (!candidate) {
        return false;
    }
    if (!baseline) {
        return true;
    }
    return String(candidate) > String(baseline);
}

/**
 * Increments an ISO UTC timestamp by a small millisecond amount without changing second precision.
 *
 * Supported forms:
 * - YYYY-MM-DDTHH:mm:ssZ
 * - YYYY-MM-DDTHH:mm:ss.SSSZ
 *
 * @param {String} isoTimestamp ISO UTC timestamp.
 * @param {Number} deltaMs Milliseconds to add.
 * @returns {String} Updated ISO timestamp, original when no increment possible, or empty on invalid input.
 */
function incrementIsoTimestampByMilliseconds(isoTimestamp, deltaMs) {
    if (!isoTimestamp) {
        return "";
    }

    var match = String(isoTimestamp).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
    if (!match) {
        return "";
    }

    var base = match[1];
    var rawFraction = String(match[2] || "");
    var millisText = "000";
    if (rawFraction) {
        millisText = rawFraction.substring(0, 3);
        while (millisText.length < 3) {
            millisText += "0";
        }
    }

    var currentMillis = parseInt(millisText, 10);
    if (isNaN(currentMillis)) {
        return "";
    }

    var increment = parseInt(deltaMs, 10);
    if (isNaN(increment) || increment <= 0) {
        return base + "." + millisText + "Z";
    }

    if (currentMillis >= 999) {
        return base + ".999Z";
    }

    var nextMillis = currentMillis + increment;
    if (nextMillis > 999) {
        nextMillis = 999;
    }

    var nextMillisText = String(nextMillis);
    while (nextMillisText.length < 3) {
        nextMillisText = "0" + nextMillisText;
    }

    return base + "." + nextMillisText + "Z";
}

/**
 * Updates stored remote-read changetime for one mirrored 3StepIT source row.
 *
 * Lookup order follows upsert3StepitSourceRow: tries source_id=deviceNumber first (migrated rows),
 * then falls back to source_id=serialNumber (legacy rows not yet migrated).
 *
 * @param {GlideRecord} integrationGR u_integration_customer record.
 * @param {String} serialNumber Device serial number.
 * @param {String} changetime New changetime to store in custom_1.
 * @param {String} [deviceNumber] Optional devicenumber for migrated rows.
 * @returns {Boolean} True when row was found and updated.
 */
function updateDeviceRowRemoteReadTimestamp(integrationGR, serialNumber, changetime, deviceNumber) {
    if (!serialNumber || !changetime) {
        return false;
    }

    var lookupId = (deviceNumber ? String(deviceNumber) : "") || String(serialNumber);

    var rowGR = new GlideRecord("x_tieoy_eus_device_row");
    rowGR.addQuery("top_company", integrationGR.u_company.u_top_company);
    rowGR.addQuery("data_source", "3stepit");
    rowGR.addQuery("source_id", lookupId);
    rowGR.setLimit(1);
    rowGR.query();

    if (!rowGR.next()) {
        if (deviceNumber) {
            // Not found by devicenumber — try legacy serialnumber key.
            var legacyGR = new GlideRecord("x_tieoy_eus_device_row");
            legacyGR.addQuery("top_company", integrationGR.u_company.u_top_company);
            legacyGR.addQuery("data_source", "3stepit");
            legacyGR.addQuery("source_id", String(serialNumber));
            legacyGR.setLimit(1);
            legacyGR.query();
            if (!legacyGR.next()) {
                return false;
            }
            rowGR = legacyGR;
        } else {
            return false;
        }
    }

    rowGR.custom_1 = String(changetime);
    rowGR.update();
    return true;
}

/**
 * Sets target_ci on one mirrored 3StepIT source row after the import transform has matched a CI.
 *
 * Called after insertImportRow() when the synchronous transform has set sys_target_sys_id on the
 * import row. Uses direct sys_id lookup to avoid a redundant query on x_tieoy_eus_device_row.
 *
 * @param {String} rowSysId Sys_id of the x_tieoy_eus_device_row record to update.
 * @param {String} targetCi Sys_id of the matched CI record from u_3stepit_asset_row.sys_target_sys_id.
 * @returns {Boolean} True when row was found and updated.
 */
function updateDeviceRowTargetCi(rowSysId, targetCi) {
    if (!rowSysId || !targetCi) {
        return false;
    }

    var rowGR = new GlideRecord("x_tieoy_eus_device_row");
    if (!rowGR.get(rowSysId)) {
        return false;
    }

    rowGR.setValue("target_ci", targetCi);
    rowGR.update();
    return true;
}

/**
 * Adds one timestamped entry to buffered execution logs.
 *
 * @param {String} message Log message.
 * @param {String} [level="debug"] Log level label.
 * @returns {String} Original message for convenient inline returns.
 */
function addLog(message, level) {

    if (!level) {
        level = "debug"; // idea only: use object array to store message and level if needed later
    }

    var allowedLevels = ["debug", "info", "warning", "error"];
    var levelPriority = allowedLevels.indexOf(level);
    var logLevelPriority = allowedLevels.indexOf(logLevel);
    if (levelPriority < logLevelPriority) {
        return message;
    }

    logArr.push(new GlideTime().getByFormat("HH:mm:ss") + " [" + level + "] " + message);

    // Error or warning messages are also logged to system logs immediately for better visibility and potential alerting.
    if (level === "error") {
        logger.logError(message);
    } else if (level === "warning") {
        logger.logWarning(message);
        //logger.logWarn(message);
    }
    return message;
}

/**
 * Builds the changetime delta filter for one fetch/retry attempt, shrinking the upper bound on each retry.
 *
 * Attempt-to-window mapping:
 * - 0 or omitted: unbounded ("changetime ge <start>"), no upper bound.
 * - 1: upper bound = start + half of the remaining (start..now) range.
 * - 2: upper bound = start + a quarter of the remaining range.
 * - 3+: upper bound = start + 1 day (last-resort fallback).
 *
 * @param {String} normalizedRemoteReadTimestamp API-format start timestamp ("changetime ge").
 * @param {Number} [attemptNumber] Retry attempt index; omit or 0 for the unbounded default.
 * @returns {String} Filter fragment for the asset query.
 */
function buildDeltaFilterForRemoteRead(normalizedRemoteReadTimestamp, attemptNumber) {
	var defaultFilter = "changetime ge " + normalizedRemoteReadTimestamp;

	var startSn = normalizeSourceUpdatedForSn(normalizedRemoteReadTimestamp);
	if (!startSn) {
		addLog("chunking skipped: could not parse " + normalizedRemoteReadTimestamp, "warning");
		return defaultFilter;
	}

    if(!attemptNumber || attemptNumber == 0){
        return defaultFilter;
    }

	var currentDateTime = new GlideDateTime();
	var endGdt = new GlideDateTime(startSn);
    var diff = (currentDateTime.getNumericValue() - endGdt.getNumericValue()) / (24 * 60 * 60 * 1000);
    if(attemptNumber == 1){
        diff = Number(diff / 2);
    }
    else if(attemptNumber == 2){
        diff = Number(diff / 4);
    }else{
        diff = 1;
    }
	endGdt.addDaysUTC(diff);

	// Never query beyond now.
	var nowGdt = new GlideDateTime();
	var upperGdt = endGdt.getNumericValue() > nowGdt.getNumericValue() ? nowGdt : endGdt;
	var upperIso = normalizeRemoteReadTimestampForApi(upperGdt.getValue());

	var chunkedFilter = "changetime ge " + normalizedRemoteReadTimestamp + " and changetime le " + upperIso;
	return chunkedFilter;
}

/**
 * Helper for standardized error exits.
 *
 * @param {String} message Error message to log and return.
 * @returns {String} Same message after logging with error level.
 */
function endInError(message) {
    addLog(message, "error");
    return message;
}

