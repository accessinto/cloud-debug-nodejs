/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

module.exports = {
  capture: capture,
  evaluate: evaluate
};

var ScopeType = require('vm').runInDebugContext('ScopeType');
var assert = require('assert');
var util = require('util');
var lodash = require('lodash');
var transform = lodash.transform;
var flatten = lodash.flatten;
var isEmpty = lodash.isEmpty;

var StatusMessage = require('../status-message.js');

// Error message indices into the resolved variable table.
var BUFFER_FULL_MESSAGE_INDEX = 0;
var NATIVE_PROPERTY_MESSAGE_INDEX = 1;
var GETTER_MESSAGE_INDEX = 2;
var ARG_LOCAL_LIMIT_MESSAGE_INDEX = 3;

/**
 * Captures the stack and current execution state.
 *
 * @return an object with stackFrames, variableTable, and
 *         evaluatedExpressions fields
 */
function capture(execState, expressions, config, v8) {
  return (new StateResolver(execState, expressions, config, v8)).capture_();
}


/**
 * Checks that the provided expressions will not have side effects and
 * then evaluates the expression in the current execution context.
 *
 * @return an object with error and mirror fields.
 */
function evaluate(expression, frame) {
  // First validate the expression to make sure it doesn't mutate state
  var acorn = require('acorn');
  try {
    var ast = acorn.parse(expression, { sourceType: 'script' });
    var validator = require('./validator');
    if (!validator.isValid(ast)) {
      return { error: 'expression not allowed'};
    }
  } catch (err) {
    return { error: err.message };
  }

  // Now actually ask V8 to evaluate the expression
  try {
    var mirror = frame.evaluate(expression);
    return {
      error: null,
      mirror: mirror
    };
  } catch (error) {
    return {
      error: error
    };
  }
}


/**
 * @param {!Object} execState
 * @param {Array<string>} expressions
 * @param {!Object} config
 * @constructor
 */
function StateResolver(execState, expressions, config, v8) {
  this.state_ = execState;
  this.expressions_ = expressions;
  this.config_ = config;
  this.ctx_ = v8;

  this.evaluatedExpressions_ = [];
  this.totalSize_ = 0;

  this.messageTable_ = [];
  this.messageTable_[BUFFER_FULL_MESSAGE_INDEX] =
    { status: new StatusMessage(StatusMessage.VARIABLE_VALUE,
                                'Max data size reached', true) };
  this.messageTable_[NATIVE_PROPERTY_MESSAGE_INDEX] =
    { status: new StatusMessage(StatusMessage.VARIABLE_VALUE,
                                'Native properties are not available', true) };
  this.messageTable_[GETTER_MESSAGE_INDEX] =
    { status: new StatusMessage(StatusMessage.VARIABLE_VALUE,
                                'Properties with getters are not available', true) };
  this.messageTable_[ARG_LOCAL_LIMIT_MESSAGE_INDEX] =
    { status: new StatusMessage(StatusMessage.VARIABLE_VALUE,
                                'Locals and arguments are only displayed for the ' +
                                'top `config.capture.maxExpandFrames=' +
                                config.capture.maxExpandFrames +
                                '` stack frames.',
                                  true) };

  this.resolvedVariableTable_ = util._extend([], this.messageTable_);
  this.rawVariableTable_ = this.messageTable_.map(function() { return null; });
}


/**
 * Captures the stack and current execution state.
 *
 * @return an object with stackFrames, variableTable, and
 *         evaluatedExpressions fields
 */
StateResolver.prototype.capture_ = function() {
  var that = this;

  // Evaluate the watch expressions
  var evalIndexSet = new Set();
  if (that.expressions_) {
    that.expressions_.forEach(function(expression, index) {
      var result = evaluate(expression, that.state_.frame(0));
      var evaluated;

      if (result.error) {
        evaluated = {
          name: expression,
          status: new StatusMessage(StatusMessage.VARIABLE_VALUE,
                                    result.error, true)
        };
      } else {
        evaluated = that.resolveVariable_(expression, result.mirror, true);
        var varTableIdx = evaluated.varTableIndex;
        if (typeof varTableIdx !== 'undefined') {
          evalIndexSet.add(varTableIdx);
        }
      }
      that.evaluatedExpressions_[index] = evaluated;
    });
  }

  // The frames are resolved after the evaluated expressions so that 
  // evaluated expressions can be evaluated as much as possible within 
  // the max data size limits
  var frames = that.resolveFrames_();

  // Now resolve the variables
  var index = this.messageTable_.length; // skip the sentinel values
  var noLimit = that.config_.capture.maxDataSize === 0;
  while (index < that.rawVariableTable_.length && // NOTE: length changes in loop
         (that.totalSize_ < that.config_.capture.maxDataSize || noLimit)) {
    assert(!that.resolvedVariableTable_[index]); // shouldn't have it resolved yet
    var isEvaluated = evalIndexSet.has(index);
    that.resolvedVariableTable_[index] =
      that.resolveMirror_(that.rawVariableTable_[index], isEvaluated);
    index++;
  }

  // If we filled up the buffer already, we need to trim the remainder
  if (index < that.rawVariableTable_.length) {
    that.trimVariableTable_(index, frames);
  }

  return {
    stackFrames: frames,
    variableTable: that.resolvedVariableTable_,
    evaluatedExpressions: that.evaluatedExpressions_
  };
};

/**
 * Limits the size of the variable table to `fromIndex` elements. It marks
 * all variables with entries beyond `fromIndex` with a message indicating
 * that the table filled.
 *
 * @param {Number} fromIndex The desired size of the variable table.
 * @param {Object} frames Frames associated with the current execution
 *                        environment.
 */
StateResolver.prototype.trimVariableTable_ = function(fromIndex, frames) {
  this.resolvedVariableTable_.splice(fromIndex); // remove the remaining entries

  var that = this;
  var processBufferFull = function(variables) {
    variables.forEach(function (variable) {
      if (variable.varTableIndex && variable.varTableIndex >= fromIndex) {
        // make it point to the sentinel 'buffer full' value
        variable.varTableIndex = BUFFER_FULL_MESSAGE_INDEX;
        variable.status = that.messageTable_[BUFFER_FULL_MESSAGE_INDEX].status;
      }
      if (variable.members) {
        processBufferFull(variable.members);
      }
    });
  };

  frames.forEach(function(frame) {
    processBufferFull(frame.arguments);
    processBufferFull(frame.locals);
  });
  processBufferFull(this.evaluatedExpressions_);
  processBufferFull(this.resolvedVariableTable_);
};

StateResolver.prototype.resolveFrames_ = function() {
  var frames = [];
  var frameCount = Math.min(this.state_.frameCount(),
    this.config_.capture.maxFrames);
    
  for (var i = 0; i < frameCount; i++) {
    var frame = this.state_.frame(i);
    if (this.shouldFrameBeResolved_(frame)) {
      frames.push(this.resolveFrame_(frame,
        (i < this.config_.capture.maxExpandFrames)));
    }
  }
  return frames;
};

StateResolver.prototype.shouldFrameBeResolved_ = function(frame) {
  // Only capture data from the frames for which we can link the data back
  // to the source files.

  var fullPath = this.resolveFullPath_(frame);

  if (!this.isPathInCurrentWorkingDirectory_(fullPath)) {
    return false;
  }

  var relativePath = this.resolveRelativePath_(frame);
  if (!this.config_.capture.includeNodeModules &&
      this.isPathInNodeModulesDirectory_(relativePath)) {
    return false;
  }

  return true;
};

StateResolver.prototype.resolveFullPath_ = function(frame) {
  var func = frame.func();
  if (!func.resolved()) {
    return '';
  }

  var script = func.script();
  if (!script) {
    return '';
  }

  return script.name();
};

StateResolver.prototype.resolveRelativePath_ = function(frame) {
  var fullPath = this.resolveFullPath_(frame);
  return this.stripCurrentWorkingDirectory_(fullPath);
};

StateResolver.prototype.stripCurrentWorkingDirectory_ = function(path) {
  // Strip 1 extra character to remove the slash.
  return path.substr(this.config_.workingDirectory.length + 1);
};

StateResolver.prototype.isPathInCurrentWorkingDirectory_ = function(path) {
  //return true;
  return path.indexOf(this.config_.workingDirectory) === 0;
};

StateResolver.prototype.isPathInNodeModulesDirectory_ = function(path) {
  return path.indexOf('node_modules') === 0;
};

StateResolver.prototype.resolveFrame_ = function(frame, underFrameCap) {
  var args = [];
  var locals = [];
  // Locals and arguments are safe to collect even when `config.allowExpressions=false`
  // since we properly avoid inspecting interceptors and getters by default.
  if (!underFrameCap) {
    args.push({
      name: 'arguments_not_available',
      varTableIndex: ARG_LOCAL_LIMIT_MESSAGE_INDEX
    });
    locals.push({
      name: 'locals_not_available',
      varTableIndex: ARG_LOCAL_LIMIT_MESSAGE_INDEX
    });
  } else {
    // We will use the values aggregated from the ScopeMirror traversal stored
    // in locals which will include any applicable arguments from the invocation.
    args = [];
    locals = this.resolveLocalsList_(frame, args);
    if (isEmpty(locals)) {
      locals = [];
    }
  }
  return {
    function: this.resolveFunctionName_(frame.func()),
    location: this.resolveLocation_(frame),
    arguments: args,
    locals: locals
  };
};

StateResolver.prototype.resolveFunctionName_ = function(func) {
  if (!func || !func.isFunction()) {
    return '';
  }
  return func.name() || func.inferredName() || '(anonymous function)';
};

StateResolver.prototype.resolveLocation_ = function(frame) {
  return {
    path: this.resolveRelativePath_(frame),
    // V8 uses 0-based line numbers but Debuglet API uses 1-based numbers.
    line: frame.sourceLine() + 1
  };
};

StateResolver.prototype.extractArgumentsList_ = function (frame) {
  var args = [];
  for (var i = 0; i < frame.argumentCount(); i++) {
    // Don't resolve unnamed arguments.
    if (!frame.argumentName(i)) {
      continue;
    }
    args.push({name: frame.argumentName(i), value: frame.argumentValue(i)});
  }
  return args;
};

/**
 * Iterates and returns variable information for all scopes (excluding global)
 * in a given frame. FrameMirrors should return their scope object list with 
 * most deeply nested scope first so variables initially encountered will take
 * precedence over subsequent instance with the same name - this is tracked in
 * the usedNames map. The argument list given to this function may be
 * manipulated if variables with a deeper scope occur which have the same name.
 * @function resolveLocalsList_
 * @memberof StateResolver
 * @param {FrameMirror} frame - A instance of FrameMirror
 * @param {Array<Object>} args - An array of objects representing any function
 *  arguments the frame may list
 * @returns {Array<Object>} - returns an array containing data about selected
 *  variables
 */
StateResolver.prototype.resolveLocalsList_ = function (frame, args) {
  var self = this;
  var usedNames = {};
  var makeMirror = this.ctx_.MakeMirror;
  return flatten(frame.allScopes().map(
    function (scope) {
      switch (scope.scopeType()) {
        case ScopeType.Global:
          // We do not capture globals in the debug client.
        case ScopeType.Closure:
          // The closure scope is contaminated by Node.JS's require IIFE pattern
          // and, if traversed, will cause local variable pools to include what
          // are considered node 'globals'. Therefore, avoid traversal.
          return [];
      }
      return transform(
        scope.details().object(),
        function (locals, value, name) {
          var trg = makeMirror(value);
          if (!usedNames[name]) {
            // It's a valid variable that belongs in the locals list and wasn't
            // discovered at a lower-scope
            usedNames[name] = true;
            locals.push(self.resolveVariable_(name, trg, false));
          } // otherwise another same-named variable occured at a lower scope
          return locals;
        },
        []
      );
    }
  )).concat((function () {
    // The frame receiver is the 'this' context that is present during 
    // invocation. Check to see whether a receiver context is substantive,
    // (invocations may be bound to null) if so: store in the locals list
    // under the name 'context' which is used by the Chrome DevTools.
    var ctx = frame.details().receiver();
    if (ctx) {
      return [self.resolveVariable_('context', makeMirror(ctx), false)];
    }
    return [];
  }()));
};

/**
 * Computes a text representation of the provided value based on its type.
 * If the value is a recursive data type, it will be represented as an index
 * into the variable table.
 *
 * @param {String} name The name of the variable.
 * @param {Object} value A v8 debugger representation of a variable value.
 * @param {boolean} isEvaluated Specifies if the variable is from a watched
 *                              expression.
 */
StateResolver.prototype.resolveVariable_ = function(name, value, isEvaluated) {
  var size = name.length;

  var data = {
    name: name
  };

  if (value.isPrimitive() || value.isRegExp()) {
    // primitives: undefined, null, boolean, number, string, symbol
    data.value = value.toText();
    var maxLength = this.config_.capture.maxStringLength;
    if (!isEvaluated && maxLength && maxLength < data.value.length) {
      data.status = new StatusMessage(StatusMessage.VARIABLE_VALUE,
        'Only first `config.capture.maxStringLength=' +
        this.config_.capture.maxStringLength +
        '` chars were captured for string of length ' + data.value.length +
        '. Use in an expression to see the full string.', false);
      data.value = data.value.substring(0, maxLength) + '...';
    }

  } else if (value.isFunction()) {
    data.value = 'function ' + this.resolveFunctionName_(value) + '()';
  } else if (value.isObject()) {
    data.varTableIndex = this.getVariableIndex_(value);
  } else {
    // PropertyMirror, InternalPropertyMirror, FrameMirror, ScriptMirror
    data.value = 'unknown mirror type';
  }

  if (data.value) {
    size += data.value.length;
  } else {
    size += 8; // fudge-it
  }

  this.totalSize_ += size;

  return data;
};

StateResolver.prototype.getVariableIndex_ = function(value) {
  var idx = this.rawVariableTable_.indexOf(value);
  if (idx === -1) {
    idx = this.storeObjectToVariableTable_(value);
  }
  return idx;
};

StateResolver.prototype.storeObjectToVariableTable_ = function(obj) {
  var idx = this.rawVariableTable_.length;
  this.rawVariableTable_[idx] = obj;
  return idx;
};

/**
 * Responsible for recursively resolving the properties on a
 * provided object mirror.
 */
StateResolver.prototype.resolveMirror_ = function(mirror, isEvaluated) {
  var properties = mirror.properties();
  var maxProps = this.config_.capture.maxProperties;
  var truncate = maxProps && properties.length > maxProps;
  if (!isEvaluated && truncate) {
    properties = properties.slice(0, maxProps);
  }
  var members = properties.map(this.resolveMirrorProperty_.bind(this, isEvaluated));
  if (!isEvaluated && truncate) {
    members.push({name: 'Only first `config.capture.maxProperties=' +
                        this.config_.capture.maxProperties +
                        '` properties were captured. Use in an expression' +
                        ' to see all properties.'});
  }
  return {
    value: mirror.toText(),
    members: members
  };
};

StateResolver.prototype.resolveMirrorProperty_ = function(isEvaluated, property) {
  var name = String(property.name());
  // Array length must be special cased as it is a native property that
  // we know to be safe to evaluate which is not generally true.
  var isArrayLen = property.mirror_.isArray() && name === 'length';
  if (property.isNative() && !isArrayLen) {
    return {
      name: name,
      varTableIndex: NATIVE_PROPERTY_MESSAGE_INDEX
    };
  }
  if (property.hasGetter()) {
    return {
      name: name,
      varTableIndex: GETTER_MESSAGE_INDEX
    };
  }
  return this.resolveVariable_(name, property.value(), isEvaluated);
};