# FEATURE 33357: Replaced by Condition Undefined Reference - Fix Memo

**Date:** 2026-08-10  
**Feature:** `33357`  
**Scope:** `x_tieoy_eus_device` — Business Rule `Update Replaced by on change of Replaces`  
**Table:** `x_tieoy_eus_device_row`

## Problem

The business rule generated error logs when the replacement relationship was evaluated:

```text
com.glide.script.RhinoEcmaError: The undefined value has no properties.
   <refname> : Line(1) column(0)
==>   1: function trecord() {return !!((current.u_replaces.changes()) && (current.u_replaces.u_source_record.nil() == false));}trecord();
```

The error occurred while ServiceNow evaluated the business rule condition. The condition attempted to call methods and access fields through `current.u_replaces` even when the `u_replaces` reference was undefined or unavailable on the current record.

## Cause

The original advanced condition evaluated a reference chain without first verifying that the field existed and contained a value:

```javascript
current.u_replaces.changes() && current.u_replaces.u_source_record.nil() == false
```

When `current.u_replaces` was undefined, evaluating `.changes()` or accessing `.u_source_record` caused Rhino to throw `The undefined value has no properties`.

This is a ServiceNow JavaScript condition, not an SQL condition. The `&&` operators are JavaScript short-circuit operators, so the field-existence and non-empty checks must appear before any method call or reference traversal.

The XML/API representation may display the operators as `&amp;&amp;`; that is only HTML/XML escaping and does not change the JavaScript behavior.

## Solution

Guard the reference before calling `changes()` or using the reference value:

```javascript
current.isValidField('u_replaces') &&
current.u_replaces.changes() &&
!current.u_replaces.nil()
```

The business rule also uses the filter conditions:

- `Replaces` changes
- `Classification.CI Domain` is `End User Services`

The condition is evaluated before the script runs. Therefore, the script can use `current.u_replaces` after the condition has passed and should retain validation for the referenced records it loads:

```javascript
var replacedRec = current.u_replaces.getRefRecord();
if (!replacedRec.isValidRecord()) {
    return;
}

if (!replacedRec.isValidField('u_source_record') || replacedRec.u_source_record.nil()) {
    return;
}
```

The `skip_sync_eus` guard remains first in the script. It prevents the update of the replaced device from causing a synchronization loop and resets the flag before returning.

## Result

The condition no longer traverses an undefined `u_replaces` reference. The business rule runs only when the field exists, has changed, and contains a value. Once triggered, the script updates the replaced device's `replaced_by` reference and marks that update to avoid another EUS synchronization pass.

## Implementation

- Business rule script: [UpdateReplacedbyonchangeofReplaces.script.js](../servicenowdev1/x_tieoy_eus_device/sys_script/UpdateReplacedbyonchangeofReplaces.script.js)
- Instance: DEV (`servicenowdev1`)
