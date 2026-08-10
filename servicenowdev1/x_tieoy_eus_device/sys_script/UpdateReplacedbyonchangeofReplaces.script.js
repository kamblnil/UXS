/**
 * Business rule: Update Replaced by on change of Replaces
 *
 * Table:       x_tieoy_eus_device_row
 * Executed on: before update
 * Condition:   Replaces changes; Classification.CI Domain is End User Services
 * Applies to:  End User Services CI domain
 * Advanced condition: current.isValidField('u_replaces') &&
 *                     current.u_replaces.changes() && !current.u_replaces.nil()
 *
 * The business rule condition validates the Replaces field before this script
 * runs. The script updates the replaced device's Replaced by reference and
 * prevents that update from being synced again.
 */
(function executeRule(current, previous) {
    if (current.skip_sync_eus == true) {
        current.skip_sync_eus = false;
        return;
    }

    var replacedRec = current.u_replaces.getRefRecord();
    if (!replacedRec.isValidRecord()) {
        return;
    }

    if (!replacedRec.isValidField('u_source_record') || replacedRec.u_source_record.nil()) {
        return;
    }

    var deviceGR = replacedRec.u_source_record.getRefRecord();
    if (!deviceGR.isValidRecord()) {
        return;
    }

    deviceGR.setValue('replaced_by', current.getUniqueValue());
    deviceGR.setValue('skip_sync_eus', true);
    deviceGR.update();
})(current, previous);

function updateDeviceRecord(deviceGR, fieldName, fieldValue) {
    if (fieldName && fieldValue !== undefined && fieldValue !== null) {
        deviceGR.setValue(fieldName, fieldValue);
    }
}