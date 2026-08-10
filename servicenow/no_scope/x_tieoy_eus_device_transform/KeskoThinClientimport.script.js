/**
 * Called from:
 * https://tieto.service-now.com/sysauto_script.do?sys_id=2e0cc0c0db1af15067db0023f396196b
 * 
 * Available variables are: 
 *  - glideRecord    Glide Record object to have the action on
 *  - logger         GSLog instance
 *  - current        This Transform entry (x_tieoy_eus_device_transform)
 *  - rule			 Instance of an Action Rule (x_tieoy_eus_action_rule)
 * 
 * Best practices:
 *  - do not try-catch within the action() - let the wrapper handle it
 *  - keep the action clean with the following phases
 *     1) safety checks
 *     2) action itself
 *     3) record update success check
 */


(function() {
    try {
        action(glideRecord);
    } catch (e) {
        return 'Exception in x_tieoy_eus_device_transform [' + current.name + "] on line " + e.lineNumber + ": " + e.message;
    }
})();

function action(ciGR) {
    var dataProvider = new x_tieoy_eus_device.SccmProvider(ciGR.integration_customer);
    var currentUser = gs.getUser().getID();
    var intCustConfigJSON = JSON.parse(ciGR.integration_customer.u_config);
    var cmdbUser = intCustConfigJSON.cmdb_integration_user;
    var appHelper = new global.EusDeviceAppHelper();
    appHelper.impersonateUser(cmdbUser);
    dataProvider.transformAndStoreRow(ciGR);
    ciGR.state = 'updated';
    // Record update success check
    var updateResult = ciGR.update();
    appHelper.impersonateUser(currentUser);
    if (!updateResult) {
        rule.error += 'CI ' + ciGR.sys_id + ' failed to update: ' + ciGR.getLastErrorMessage();
    } else {
        if (global.JSUtil.nil(rule.successUpdateCount)) {
            rule.successUpdateCount = 1;
        } else {
            rule.successUpdateCount++;
        }
    }
    rule.result = 'Success update count: ' + rule.successUpdateCount;
}