/**
 * Since 2026-05-27/xxmaenpm:
 * Needed for urgent setup of bypassing Foxway Hw orders and using on-site local stock instead
 * 
 * Available variables are: 
 *  - glideRecord    Glide Record object to have the action on
 *  - logger         GSLog instance
 *  - current        This Transform entry (x_tieoy_eus_device_transform)
 *  - rule           Instance of an Action Rule (x_tieoy_eus_action_rule)
 */
var eusBaseUtil = new global.EusBaseUtil();
var appHelper = new global.PCACappHelper();
var JSUtil = global.JSUtil;
var logArr = [];
var ritmGR = glideRecord;

(function() {
    try {
        var result = action(); // Result should be the latest log entry and passed to AR result

        // Execution log print out
        if (logArr.length > 0) {
            ritmGR.work_notes = current.getDisplayValue() + ' execution log:\n' + logArr.join('\n');
        }

        // Target record update
        if (typeof rule === 'undefined') {
            // calling from RITM workflow, no need to update RITM
        } else {
            // calling from an action rule (or from BG script) we will update the RITM
            ritmGR.update();
            rule.result += ritmGR.number + ': ' + result + '\n';
        }
        return '';
    } catch (e) {
        return 'Exception in x_tieoy_eus_device_transform [' + current.getDisplayValue() + '] on line ' + e.lineNumber + ': ' + e.message + ' --> ' + JSON.stringify(e);
    }
})();

function action() {

    var taskGR = createTask(ritmGR);
	if (JSUtil.nil(taskGR)) {
		return endInError('Unable to create a task to on-site');
	}
	ritmGR.u_correlation_state = 'On-site task created successfully'; // Signal keyword "success" to the workflow
    return addLog(taskGR.number + ' for on-site created'); // this last return is logged on the AR result.

}

function addLog(message, level) {
    if (!level) {
        level = 'debug'; // idea, only -- use object array to store message and its level
    }
    //logArr.push(new GlideDateTime().getNumericValue() + ' ' + message);
    logArr.push(new GlideTime().getByFormat('HH:mm:ss') + ' ' + message);
    return message;
}

function endInError(message) {
    if (logger && logger.logWarning) {
        logger.logWarning(message);
    }
    addLog(message, 'error');
    ritmGR.close_notes = 'Workflow ended in error';
    ritmGR.u_correlation_state = 'error';
    return message;
}


function createTask(ritmGR) {

    var shortDescription = "LCM laptop order for on-site";
	shortDescription = ritmGR.short_description; // better one?
    var description = "User needs a computer - assign one from the on-site stock!";
	//description += '\n' + ritmGR.description;
	description = '';

    var taskGR = new GlideRecord("sc_task");
    taskGR.initialize();
    taskGR.request_item = ritmGR.sys_id;
    taskGR.parent = ritmGR.sys_id;
    taskGR.short_description = shortDescription;
    taskGR.description = description;
    taskGR.company = ritmGR.company;
    var callerLocation = String(ritmGR.u_caller_id.location);
    taskGR.location = 'f9b1f57293f5b6d0c26073258aba104c'; // Finland fallback
    if (!JSUtil.nil(callerLocation)) {
        taskGR.location = callerLocation;
    }
    taskGR.service_offering = '100ac4d71b3778d4c5f8dc2c9b4bcb86'; // FSO On-site by Experis
	taskGR.assignment_group = taskGR.service_offering.support_group; // weird that this needs to exist, inheritance from FSO is not automatic
    taskGR.u_caller_id = ritmGR.u_caller_id;
    taskGR.business_service = ritmGR.business_service;
    taskGR.request = ritmGR.request;
    var id = appHelper.insertGlideRecord(taskGR);
    if (id) {
        return taskGR;
    }
	return null;
}