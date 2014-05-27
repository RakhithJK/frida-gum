/*
 * TODO Frida Runtime:
 *
 *   - NativePointer: isNull()
 *   - global NULL constant
 *   - Memory.writeU16 et al
 *   - Memory.writePointer
 *   - Memory.writeByteArray
 *   - Memory.dup (memdup)
 *   - Memory.copy (memcpy)
 *   - NativePointer.add should return this when 0
 */

(function () {
    var _runtime = null;
    var _api = null;
    var pointerSize = Process.pointerSize;
    var scratchBuffer = Memory.alloc(pointerSize);
    var NULL = ptr("0");
    var JNI_OK = 0;
    var JNI_VERSION_1_6 = 0x00010006;

    var CONSTRUCTOR_METHOD = 1;
    var STATIC_METHOD = 2;
    var INSTANCE_METHOD = 3;

    /* TODO: 64-bit */
    var JNI_ENV_OFFSET_SELF = 12;

    var CLASS_OBJECT_SIZE = 160;
    var CLASS_OBJECT_OFFSET_VTABLE_COUNT = 112;
    var CLASS_OBJECT_OFFSET_VTABLE = 116;

    var OBJECT_OFFSET_CLAZZ = 0;

    var METHOD_SIZE = 56;
    var METHOD_OFFSET_CLAZZ = 0;
    var METHOD_OFFSET_ACCESS_FLAGS = 4;
    var METHOD_OFFSET_METHOD_INDEX = 8;
    var METHOD_OFFSET_REGISTERS_SIZE = 10;
    var METHOD_OFFSET_OUTS_SIZE = 12;
    var METHOD_OFFSET_INS_SIZE = 14;
    var METHOD_OFFSET_INSNS = 32;
    var METHOD_OFFSET_JNI_ARG_INFO = 36;

    Object.defineProperty(this, 'Dalvik', {
        enumerable: true,
        get: function () {
            if (_runtime === null) {
                _runtime = new Runtime();
            }
            return _runtime;
        }
    });

    var Runtime = function Runtime() {
        var api = null;
        var vm = null;
        var classFactory = null;
        var pendingCallbacks = [];
        var scheduledCallbacks = [];

        var initialize = function () {
            api = getApi();
            if (api !== null) {
                vm = new VM(api);
                classFactory = new ClassFactory(api, vm);
            }
        };

        Object.defineProperty(this, 'available', {
            enumerable: true,
            get: function () {
                return api !== null;
            }
        });

        this.perform = function (fn) {
            if (api === null) {
                throw new Error("Dalvik runtime not available");
            }

            return vm.perform(fn);
        };

        this.use = function (className) {
            return classFactory.use(className);
        };

        this.cast = function (handle, C) {
            return classFactory.cast(handle, C);
        };

        initialize.call(this);
    };

    var ClassFactory = function ClassFactory(api, vm) {
        var factory = this;
        var classes = {};
        var patchedClasses = {};

        var initialize = function () {
            api = getApi();
        };

        WeakRef.bind(Runtime, function dispose() {
            vm.perform(function () {
                var env = vm.getEnv();

                for (entryId in patchedClasses) {
                    if (patchedClasses.hasOwnProperty(entryId)) {
                        var entry = patchedClasses[entryId];
                        writePointer(entry.vtablePtr, entry.vtable);
                        writeU32(entry.vtableCountPtr, entry.vtableCount); // TODO: S32

                        for (methodId in entry.targetMethods) {
                            if (entry.targetMethods.hasOwnProperty(methodId)) {
                                entry.targetMethods[methodId].implementation = null;
                            }
                        }
                    }
                }
                patchedClasses = {};

                for (classId in classes) {
                    if (classes.hasOwnProperty(classId)) {
                        var klass = classes[classId];
                        env.deleteGlobalRef(klass.__handle__);
                    }
                }
                classes = {};
            });
        });

        this.use = function (className) {
            var klass = classes[className];
            if (!klass) {
                var env = vm.getEnv();
                var handle = env.findClass(className.replace(/\./g, "/"));
                if (handle.toString(16) === "0") {
                    throw new Error("Class '" + className + "' is not loaded");
                }
                var C = ensureClass(handle, className);
                klass = new C(handle, null);
                env.deleteLocalRef(handle);
            }
            return klass;
        };

        this.cast = function (handle, C) {
            return new C(C.__handle__, handle);
        };

        var ensureClass = function (classHandle, cachedName) {
            var env = vm.getEnv();

            var name = cachedName !== null ? cachedName : env.getClassName(classHandle);
            var klass = classes[name];
            if (klass) {
                return klass;
            }

            var superHandle = env.getSuperclass(classHandle);
            var superKlass;
            if (superHandle.toString(16) !== "0") {
                superKlass = ensureClass(superHandle, null);
                env.deleteLocalRef(superHandle);
            } else {
                superKlass = null;
            }

            eval("klass = function " + basename(name) + "(classHandle, handle) {" +
                 "var env = vm.getEnv();" +
                 "this.$class = klass;" +
                 "this.$classHandle = env.newGlobalRef(classHandle);" +
                 "this.$handle = (handle !== null) ? env.newGlobalRef(handle) : null;" +
                 "this.$weakRef = WeakRef.bind(this, makeHandleDestructor(this.$handle, this.$classHandle));" +
            "};");

            classes[name] = klass;

            var initializeClass = function initializeClass() {
                klass.__name__ = name;
                klass.__handle__ = env.newGlobalRef(classHandle);

                klass.prototype.$new = makeConstructor();
                klass.prototype.$dispose = dispose;

                addMethods();
            };

            var dispose = function () {
                WeakRef.unbind(this.$weakRef);
            };

            var makeConstructor = function () {
                var Constructor = env.javaLangReflectConstructor();
                var invokeObjectMethodNoArgs = env.method('pointer', []);

                var jsMethods = [];
                var jsRetType = objectType(name, false);
                var constructors = invokeObjectMethodNoArgs(env.handle, classHandle, env.javaLangClass().getDeclaredConstructors);
                var numConstructors = env.getArrayLength(constructors);
                for (var constructorIndex = 0; constructorIndex !== numConstructors; constructorIndex++) {
                    var constructor = env.getObjectArrayElement(constructors, constructorIndex);

                    var methodId = env.fromReflectedMethod(constructor);
                    var jsArgTypes = [];

                    var types = invokeObjectMethodNoArgs(env.handle, constructor, Constructor.getGenericParameterTypes);
                    env.deleteLocalRef(constructor);
                    var numTypes = env.getArrayLength(types);
                    try {
                        for (var typeIndex = 0; typeIndex !== numTypes; typeIndex++) {
                            var t = env.getObjectArrayElement(types, typeIndex);
                            try {
                                var argType = typeFromClassName(env.getTypeName(t));
                                jsArgTypes.push(argType);
                            } finally {
                                env.deleteLocalRef(t);
                            }
                        }
                    } catch (e) {
                        continue;
                    } finally {
                        env.deleteLocalRef(types);
                    }

                    jsMethods.push(makeMethod(CONSTRUCTOR_METHOD, methodId, jsRetType, jsArgTypes));
                }
                env.deleteLocalRef(constructors);

                return makeMethodDispatcher("<init>", jsMethods);
            };

            var addMethods = function () {
                var Method = env.javaLangReflectMethod();
                var Modifier = env.javaLangReflectModifier();
                var invokeObjectMethodNoArgs = env.method('pointer', []);
                var invokeIntMethodNoArgs = env.method('int32', []);

                var jsMethods = {};
                var methods = invokeObjectMethodNoArgs(env.handle, classHandle, env.javaLangClass().getDeclaredMethods);
                var numMethods = env.getArrayLength(methods);
                for (var methodIndex = 0; methodIndex !== numMethods; methodIndex++) {
                    var method = env.getObjectArrayElement(methods, methodIndex);
                    var methodId = env.fromReflectedMethod(method);
                    var name = invokeObjectMethodNoArgs(env.handle, method, Method.getName);
                    var retType = invokeObjectMethodNoArgs(env.handle, method, Method.getGenericReturnType);
                    var argTypes = invokeObjectMethodNoArgs(env.handle, method, Method.getGenericParameterTypes);
                    var modifiers = invokeIntMethodNoArgs(env.handle, method, Method.getModifiers);
                    env.deleteLocalRef(method);

                    var jsName = env.stringFromJni(name);
                    var jsType = (modifiers & Modifier.STATIC) != 0 ? STATIC_METHOD : INSTANCE_METHOD;
                    var jsRetType;
                    var jsArgTypes = [];

                    env.deleteLocalRef(name);

                    try {
                        jsRetType = typeFromClassName(env.getTypeName(retType));
                    } catch (e) {
                        env.deleteLocalRef(argTypes);
                        continue;
                    } finally {
                        env.deleteLocalRef(retType);
                    }

                    try {
                        var numArgTypes = env.getArrayLength(argTypes);
                        for (var argTypeIndex = 0; argTypeIndex !== numArgTypes; argTypeIndex++) {
                            var t = env.getObjectArrayElement(argTypes, argTypeIndex);
                            try {
                                var argType = typeFromClassName(env.getTypeName(t));
                                jsArgTypes.push(argType);
                            } finally {
                                env.deleteLocalRef(t);
                            }
                        }
                    } catch (e) {
                        continue;
                    } finally {
                        env.deleteLocalRef(argTypes);
                    }

                    var jsOverloads;
                    if (jsMethods.hasOwnProperty(jsName)) {
                        jsOverloads = jsMethods[jsName];
                    } else {
                        jsOverloads = [];
                        jsMethods[jsName] = jsOverloads;
                    }
                    jsOverloads.push(makeMethod(jsType, methodId, jsRetType, jsArgTypes));
                }

                for (var methodName in jsMethods) {
                    if (jsMethods.hasOwnProperty(methodName)) {
                        var overloads = jsMethods[methodName];
                        if (methodName === 'valueOf') {
                            var hasDefaultValueOf = overloads.some(function implementsDefaultValueOf(overload) {
                                return overload.type === INSTANCE_METHOD && overload.argumentTypes.length === 0;
                            });
                            if (!hasDefaultValueOf) {
                                var defaultValueOf = function defaultValueOf() {
                                    return this;
                                };

                                Object.defineProperty(defaultValueOf, 'holder', {
                                    enumerable: true,
                                    value: klass
                                });

                                Object.defineProperty(defaultValueOf, 'type', {
                                    enumerable: true,
                                    value: INSTANCE_METHOD
                                });

                                Object.defineProperty(defaultValueOf, 'returnType', {
                                    enumerable: true,
                                    value: typeFromClassName('int')
                                });

                                Object.defineProperty(defaultValueOf, 'argumentTypes', {
                                    enumerable: true,
                                    value: []
                                });

                                Object.defineProperty(defaultValueOf, 'canInvokeWith', {
                                    enumerable: true,
                                    value: function (args) {
                                        return args.length === 0;
                                    }
                                });

                                overloads.push(defaultValueOf);
                            }
                        }
                        klass.prototype[methodName] = makeMethodDispatcher(methodName, overloads);
                    }
                }
            };

            var makeMethodDispatcher = function (name, methods) {
                var candidates = {};
                methods.forEach(function (m) {
                    var numArgs = m.argumentTypes.length;
                    var group = candidates[numArgs];
                    if (!group) {
                        group = [];
                        candidates[numArgs] = group;
                    }
                    group.push(m);
                });

                var f = function () {
                    var isInstance = this.$handle !== null;
                    if (methods[0].type !== INSTANCE_METHOD && isInstance) {
                        throw new Error(name + ": cannot call static method by way of an instance");
                    } else if (methods[0].type === INSTANCE_METHOD && !isInstance) {
                        throw new Error(name + ": cannot call instance method without an instance");
                    }
                    var group = candidates[arguments.length];
                    if (!group) {
                        throw new Error(name + ": argument count does not match any overload");
                    }
                    for (var i = 0; i !== group.length; i++) {
                        var method = group[i];
                        if (method.canInvokeWith(arguments)) {
                            return method.apply(this, arguments);
                        }
                    }
                    throw new Error(name + ": argument types do not match any overload");
                };

                Object.defineProperty(f, 'overloads', {
                    enumerable: true,
                    value: methods
                });

                Object.defineProperty(f, 'overload', {
                    enumerable: true,
                    value: function () {
                        var group = candidates[arguments.length];
                        if (!group) {
                            throw new Error(name + ": argument count does not match any overload");
                        }

                        var signature = Array.prototype.join.call(arguments, ":");
                        for (var i = 0; i !== group.length; i++) {
                            var method = group[i];
                            var s = method.argumentTypes.map(function (t) { return t.className; }).join(":");
                            if (s === signature) {
                                return method;
                            }
                        }
                        throw new Error(name + ": specified argument types do not match any overload");
                    }
                });

                Object.defineProperty(f, 'holder', {
                    enumerable: true,
                    get: methods[0].holder
                });

                Object.defineProperty(f, 'type', {
                    enumerable: true,
                    value: methods[0].type
                });

                if (methods.length === 1) {
                    Object.defineProperty(f, 'implementation', {
                        enumerable: true,
                        get: function () {
                            return methods[0].implementation;
                        },
                        set: function (imp) {
                            methods[0].implementation = imp;
                        }
                    });

                    Object.defineProperty(f, 'returnType', {
                        enumerable: true,
                        value: methods[0].returnType
                    });

                    Object.defineProperty(f, 'argumentTypes', {
                        enumerable: true,
                        value: methods[0].argumentTypes
                    });

                    Object.defineProperty(f, 'canInvokeWith', {
                        enumerable: true,
                        value: methods[0].canInvokeWith
                    });
                } else {
                    var throwAmbiguousError = function () {
                        throw new Error("Method has more than one overload. Please resolve by for example: `method.overload('int')`");
                    };

                    Object.defineProperty(f, 'implementation', {
                        enumerable: true,
                        get: throwAmbiguousError,
                        set: throwAmbiguousError
                    });

                    Object.defineProperty(f, 'returnType', {
                        enumerable: true,
                        get: throwAmbiguousError
                    });

                    Object.defineProperty(f, 'argumentTypes', {
                        enumerable: true,
                        get: throwAmbiguousError
                    });

                    Object.defineProperty(f, 'canInvokeWith', {
                        enumerable: true,
                        get: throwAmbiguousError
                    });
                }

                return f;
            };

            var makeMethod = function (type, methodId, retType, argTypes) {
                var targetMethodId = methodId;
                var originalMethodId = null;

                var rawRetType = retType.type;
                var rawArgTypes = argTypes.map(function (t) { return t.type; });
                var invokeTarget;
                if (type == CONSTRUCTOR_METHOD) {
                    invokeTarget = env.constructor(rawArgTypes);
                } else if (type == STATIC_METHOD) {
                    invokeTarget = env.staticMethod(rawRetType, rawArgTypes);
                } else if (type == INSTANCE_METHOD) {
                    invokeTarget = env.method(rawRetType, rawArgTypes);
                }

                var frameCapacity = 2;
                var argVariableNames = argTypes.map(function (t, i) {
                    return "a" + (i + 1);
                });
                var callArgs = [
                    "env.handle",
                    type === INSTANCE_METHOD ? "this.$handle" : "this.$classHandle",
                    "targetMethodId"
                ].concat(argTypes.map(function (t, i) {
                    if (t.toJni) {
                        frameCapacity++;
                        return "argTypes[" + i + "].toJni.call(this, " + argVariableNames[i] + ", env)";
                    }
                    return argVariableNames[i];
                }));
                var returnCapture, returnStatement;
                if (rawRetType === 'void') {
                    returnCapture = "";
                    returnStatements = "env.popLocalFrame(NULL);";
                } else {
                    if (retType.fromJni) {
                        frameCapacity++;
                        returnCapture = "var rawResult = ";
                        returnStatements = "var result = retType.fromJni.call(this, rawResult, env);" +
                            "env.popLocalFrame(NULL);" +
                            "return result;";
                    } else {
                        returnCapture = "var result = ";
                        returnStatements = "env.popLocalFrame(NULL);" +
                            "return result;";
                    }
                }
                eval("var f = function (" + argVariableNames.join(", ") + ") {" +
                    "var env = vm.getEnv();" +
                    "if (env.pushLocalFrame(" + frameCapacity + ") !== JNI_OK) {" +
                        "env.exceptionClear();" +
                        "throw new Error(\"Out of memory\");" +
                    "}" +
                    "synchronizeVtable.call(this, env);" +
                    returnCapture + "invokeTarget(" + callArgs.join(", ") + ");" +
                    "var throwable = env.exceptionOccurred();" +
                    "if (throwable.toString(16) !== \"0\") {" +
                        "env.exceptionClear();" +
                        "var description = env.method('pointer', [])(env.handle, throwable, env.javaLangObject().toString);" +
                        "var descriptionStr = env.stringFromJni(description);" +
                        "env.popLocalFrame(NULL);" +
                        "throw new Error(descriptionStr);" +
                    "}" +
                    returnStatements +
                "}");

                Object.defineProperty(f, 'holder', {
                    enumerable: true,
                    value: klass
                });

                Object.defineProperty(f, 'type', {
                    enumerable: true,
                    value: type
                });

                var implementation = null;
                var synchronizeVtable = function (env) {
                    if (originalMethodId === null) {
                        return; /* nothing to do – implementation hasn't been replaced */
                    }

                    var thread = Memory.readPointer(env.handle.add(JNI_ENV_OFFSET_SELF));
                    var object = api.dvmDecodeIndirectRef(thread, this.$handle);
                    var classObject = Memory.readPointer(object.add(OBJECT_OFFSET_CLAZZ));
                    var key = classObject.toString(16);
                    var entry = patchedClasses[key];
                    if (!entry) {
                        var vtablePtr = classObject.add(CLASS_OBJECT_OFFSET_VTABLE);
                        var vtableCountPtr = classObject.add(CLASS_OBJECT_OFFSET_VTABLE_COUNT);
                        var vtable = Memory.readPointer(vtablePtr);
                        var vtableCount = Memory.readS32(vtableCountPtr);

                        var vtableSize = vtableCount * pointerSize;
                        var shadowVtable = Memory.alloc(2 * vtableSize);
                        memcpy(shadowVtable, vtable, vtableSize);
                        writePointer(vtablePtr, shadowVtable);

                        entry = {
                            classObject: classObject,
                            vtablePtr: vtablePtr,
                            vtableCountPtr: vtableCountPtr,
                            vtable: vtable,
                            vtableCount: vtableCount,
                            shadowVtable: shadowVtable,
                            shadowVtableCount: vtableCount,
                            targetMethods: {}
                        };
                        patchedClasses[key] = entry;
                    }

                    key = methodId.toString(16);
                    var method = entry.targetMethods[key];
                    if (!method) {
                        var methodIndex = entry.shadowVtableCount++;
                        writePointer(entry.shadowVtable.add(methodIndex * pointerSize), targetMethodId);
                        writeU16(targetMethodId.add(METHOD_OFFSET_METHOD_INDEX), methodIndex);
                        writeU32(entry.vtableCountPtr, entry.shadowVtableCount); // TODO: S32

                        entry.targetMethods[key] = f;
                    }
                };
                Object.defineProperty(f, 'implementation', {
                    enumerable: true,
                    get: function () {
                        return implementation;
                    },
                    set: function (fn) {
                        if (fn === null && originalMethodId === null) {
                            return;
                        }

                        if (originalMethodId === null) {
                            originalMethodId = memdup(methodId, METHOD_SIZE);
                            targetMethodId = memdup(methodId, METHOD_SIZE);
                        }

                        if (fn !== null) {
                            implementation = implement(f, fn);

                            var argsSize = argTypes.reduce(function (acc, t) { return acc + t.size; }, 0);
                            if (type === INSTANCE_METHOD) {
                                argsSize++;
                            }

                            var accessFlags = Memory.readU32(methodId.add(METHOD_OFFSET_ACCESS_FLAGS)) | 0x0100;
                            var registersSize = argsSize;
                            var outsSize = 0;
                            var insSize = argsSize;
                            var jniArgInfo = 0x80000000;

                            writeU32(methodId.add(METHOD_OFFSET_ACCESS_FLAGS), accessFlags);
                            writeU16(methodId.add(METHOD_OFFSET_REGISTERS_SIZE), registersSize);
                            writeU16(methodId.add(METHOD_OFFSET_OUTS_SIZE), outsSize);
                            writeU16(methodId.add(METHOD_OFFSET_INS_SIZE), insSize);
                            writeU32(methodId.add(METHOD_OFFSET_JNI_ARG_INFO), jniArgInfo);

                            api.dvmUseJNIBridge(methodId, implementation);
                        } else {
                            memcpy(methodId, originalMethodId, METHOD_SIZE);
                        }
                    }
                });

                Object.defineProperty(f, 'returnType', {
                    enumerable: true,
                    value: retType
                });

                Object.defineProperty(f, 'argumentTypes', {
                    enumerable: true,
                    value: argTypes
                });

                Object.defineProperty(f, 'canInvokeWith', {
                    enumerable: true,
                    value: function (args) {
                        if (args.length !== argTypes.length) {
                            return false;
                        }

                        return argTypes.every(function (t, i) {
                            return t.isCompatible(args[i]);
                        });
                    }
                });

                return f;
            };

            if (superKlass !== null) {
                var Surrogate = function () {
                    this.constructor = klass;
                };
                Surrogate.prototype = superKlass.prototype;
                klass.prototype = new Surrogate();

                klass.__super__ = superKlass.prototype;
            } else {
                klass.__super__ = null;
            }

            initializeClass();

            return klass;
        };

        var makeHandleDestructor = function () {
            var handles = Array.prototype.slice.call(arguments).filter(function (h) { return h !== null; });
            return function () {
                vm.perform(function () {
                    var env = vm.getEnv();
                    handles.forEach(env.deleteGlobalRef);
                });
            };
        };

        var implement = function (method, fn) {
            var env = vm.getEnv();

            if (method.hasOwnProperty('overloads')) {
                if (method.overloads.length > 1) {
                    throw new Error("Method has more than one overload. Please resolve by for example: `method.overload('int')`");
                }
                method = method.overloads[0];
            }

            var C = method.holder;
            var type = method.type;
            var retType = method.returnType;
            var argTypes = method.argumentTypes;
            var rawRetType = retType.type;
            var rawArgTypes = argTypes.map(function (t) { return t.type; });
            var invokeTarget;
            if (type == CONSTRUCTOR_METHOD) {
                invokeTarget = env.constructor(rawArgTypes);
            } else if (type == STATIC_METHOD) {
                invokeTarget = env.staticMethod(rawRetType, rawArgTypes);
            } else if (type == INSTANCE_METHOD) {
                invokeTarget = env.method(rawRetType, rawArgTypes);
            }

            var frameCapacity = 2;
            var argVariableNames = argTypes.map(function (t, i) {
                return "a" + (i + 1);
            });
            var callArgs = argTypes.map(function (t, i) {
                if (t.fromJni) {
                    frameCapacity++;
                    return "argTypes[" + i + "].fromJni.call(this, " + argVariableNames[i] + ", env)";
                }
                return argVariableNames[i];
            });
            var returnCapture, returnStatement, returnNothing;
            if (rawRetType === 'void') {
                returnCapture = "";
                returnStatements = "env.popLocalFrame(NULL);";
                returnNothing = "return;"
            } else {
                if (retType.toJni) {
                    frameCapacity++;
                    returnCapture = "var result = ";
                    if (retType.type === 'pointer') {
                        returnStatements = "var rawResult = retType.toJni.call(this, result, env);" +
                            "return env.popLocalFrame(rawResult);";
                        returnNothing = "return NULL;"
                    } else {
                        returnStatements = "var rawResult = retType.toJni.call(this, result, env);" +
                            "env.popLocalFrame(NULL);" +
                            "return rawResult;";
                        returnNothing = "return 0;"
                    }
                } else {
                    returnCapture = "var result = ";
                    returnStatements = "env.popLocalFrame(NULL);" +
                        "return result;";
                    returnNothing = "return 0;"
                }
            }
            eval("var f = function (" + ["envHandle", "thisHandle"].concat(argVariableNames).join(", ") + ") {" +
                "var env = new Env(envHandle);" +
                "if (env.pushLocalFrame(" + frameCapacity + ") !== JNI_OK) {" +
                    "return;" +
                "}" +
                ((type === INSTANCE_METHOD) ? "var self = new C(C.__handle__, thisHandle);" : "var self = new C(thisHandle, null);") +
                "try {" +
                    returnCapture + "fn.call(" + ["self"].concat(callArgs).join(", ") + ");" +
                "} catch (e) {" +
                    "if (typeof e === 'object' && e.hasOwnProperty('$handle')) {" +
                        "env.throw(e.$handle);" +
                        returnNothing +
                    "} else {" +
                        "throw e;" +
                    "}" +
                "}" +
                returnStatements +
            "}");

            Object.defineProperty(f, 'type', {
                enumerable: true,
                value: type
            });

            Object.defineProperty(f, 'returnType', {
                enumerable: true,
                value: retType
            });

            Object.defineProperty(f, 'argumentTypes', {
                enumerable: true,
                value: argTypes
            });

            Object.defineProperty(f, 'canInvokeWith', {
                enumerable: true,
                value: function (args) {
                    if (args.length !== argTypes.length) {
                        return false;
                    }

                    return argTypes.every(function (t, i) {
                        return t.isCompatible(args[i]);
                    });
                }
            });

            return new NativeCallback(f, rawRetType, ['pointer', 'pointer'].concat(rawArgTypes));
        };

        var typeFromClassName = function (className) {
            var type = types[className];
            if (!type) {
                if (className.indexOf("[") === 0) {
                    throw new Error("Unsupported type: " + className);
                }
                type = objectType(className, true);
            }

            var result = {
                className: className
            };
            for (var key in type) {
                if (type.hasOwnProperty(key)) {
                    result[key] = type[key];
                }
            }
            return result;
        };

        var types = {
            'boolean': {
                type: 'uint8',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'boolean';
                },
                fromJni: function (v) {
                    return v ? true : false;
                },
                toJni: function (v) {
                    return v ? 1 : 0;
                }
            },
            'byte': {
                type: 'int8',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'char': {
                type: 'uint16',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'string' && v.length === 1;
                },
                fromJni: function (c) {
                    return String.fromCharCode(c);
                },
                toJni: function (s) {
                    return s.charCodeAt(0);
                }
            },
            'short': {
                type: 'int16',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'int': {
                type: 'int32',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'long': {
                type: 'int64',
                size: 2,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'float': {
                type: 'float',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'double': {
                type: 'double',
                size: 2,
                isCompatible: function (v) {
                    return typeof v === 'number';
                }
            },
            'void': {
                type: 'void',
                size: 0,
                isCompatible: function (v) {
                    return false;
                }
            },
            '[B': {
                type: 'pointer',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'object' && v.hasOwnProperty('length');
                },
                fromJni: function () {
                    throw new Error("Not yet implemented ([B)");
                },
                toJni: function () {
                    throw new Error("Not yet implemented ([B)");
                }
            },
            '[C': {
                type: 'pointer',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'object' && v.hasOwnProperty('length');
                },
                fromJni: function () {
                    throw new Error("Not yet implemented ([C)");
                },
                toJni: function () {
                    throw new Error("Not yet implemented ([C)");
                }
            },
            '[I': {
                type: 'pointer',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'object' && v.hasOwnProperty('length');
                },
                fromJni: function () {
                    throw new Error("Not yet implemented ([I)");
                },
                toJni: function () {
                    throw new Error("Not yet implemented ([I)");
                }
            },
            '[Ljava.lang.String;': {
                type: 'pointer',
                size: 1,
                isCompatible: function (v) {
                    return typeof v === 'object' && v.hasOwnProperty('length') && (v.length === 0 || typeof v[0] === 'string');
                },
                fromJni: function (h, env) {
                    var result = [];
                    var length = env.getArrayLength(h);
                    for (var i = 0; i !== length; i++) {
                        var s = env.getObjectArrayElement(h, i);
                        result.push(env.stringFromJni(s));
                        env.deleteLocalRef(s);
                    }
                    return result;
                },
                toJni: function (strings, env) {
                    var result = env.newObjectArray(strings.length, env.javaLangString().handle, NULL);
                    for (var i = 0; i !== strings.length; i++) {
                        var s = env.newStringUtf(strings[i]);
                        env.setObjectArrayElement(result, i, s);
                        env.deleteLocalRef(s);
                    }
                    return result;
                }
            }
        };

        var objectType = function (className, unbox) {
            return {
                type: 'pointer',
                size: 1,
                isCompatible: function (v) {
                    if (className === 'java.lang.String' && typeof v === 'string') {
                        return true;
                    }

                    return typeof v === 'object' && v.hasOwnProperty('$handle'); // TODO: improve strictness
                },
                fromJni: function (h, env) {
                    if (h.toString(16) === "0") {
                        return null;
                    } else if (className === 'java.lang.String' && unbox) {
                        return env.stringFromJni(h);
                    } else if (this.$handle !== null && env.isSameObject(h, this.$handle)) {
                        return this;
                    } else {
                        return factory.cast(h, factory.use(className));
                    }
                },
                toJni: function (o, env) {
                    if (typeof o === 'string') {
                        return env.newStringUtf(o);
                    }

                    return o.$handle;
                }
            };
        };

        initialize.call(this);
    };

    var VM = function VM(api) {
        var handle = null;
        var attachCurrentThread = null;
        var detachCurrentThread = null;
        var getEnv = null;

        var initialize = function () {
            handle = Memory.readPointer(api.gDvmJni.add(8));

            var vtable = Memory.readPointer(handle);
            attachCurrentThread = new NativeFunction(Memory.readPointer(vtable.add(4 * pointerSize)), 'int32', ['pointer', 'pointer', 'pointer']);
            detachCurrentThread = new NativeFunction(Memory.readPointer(vtable.add(5 * pointerSize)), 'int32', ['pointer']);
            getEnv = new NativeFunction(Memory.readPointer(vtable.add(6 * pointerSize)), 'int32', ['pointer', 'pointer', 'int32']);
        };

        this.perform = function (fn) {
            var env = this.tryGetEnv();
            var alreadyAttached = env !== null;
            if (!alreadyAttached) {
                env = this.attachCurrentThread();
            }

            var result;
            var pendingException = null;
            try {
                result = fn();
            } catch (e) {
                pendingException = e;
            }

            if (!alreadyAttached) {
                this.detachCurrentThread();
            }

            if (pendingException !== null) {
                throw pendingException;
            }

            return result;
        };

        this.attachCurrentThread = function () {
            checkJniResult("VM::AttachCurrentThread", attachCurrentThread(handle, scratchBuffer, NULL));
            return new Env(Memory.readPointer(scratchBuffer));
        };

        this.detachCurrentThread = function () {
            checkJniResult("VM::DetachCurrentThread", detachCurrentThread(handle));
        };

        this.getEnv = function () {
            checkJniResult("VM::GetEnv", getEnv(handle, scratchBuffer, JNI_VERSION_1_6));
            return new Env(Memory.readPointer(scratchBuffer));
        };

        this.tryGetEnv = function () {
            var result = getEnv(handle, scratchBuffer, JNI_VERSION_1_6);
            if (result !== JNI_OK) {
                return null;
            }
            return new Env(Memory.readPointer(scratchBuffer));
        };

        initialize.call(this);
    };

    function Env(handle) {
        this.handle = handle;
    }

    (function () {
        var CALL_CONSTRUCTOR_METHOD_OFFSET = 28;

        var CALL_OBJECT_METHOD_OFFSET = 34;
        var CALL_BOOLEAN_METHOD_OFFSET = 37;
        var CALL_BYTE_METHOD_OFFSET = 40;
        var CALL_CHAR_METHOD_OFFSET = 43;
        var CALL_SHORT_METHOD_OFFSET = 46;
        var CALL_INT_METHOD_OFFSET = 49;
        var CALL_LONG_METHOD_OFFSET = 52;
        var CALL_FLOAT_METHOD_OFFSET = 55;
        var CALL_DOUBLE_METHOD_OFFSET = 58;
        var CALL_VOID_METHOD_OFFSET = 61;

        var CALL_STATIC_OBJECT_METHOD_OFFSET = 114;
        var CALL_STATIC_BOOLEAN_METHOD_OFFSET = 117;
        var CALL_STATIC_BYTE_METHOD_OFFSET = 120;
        var CALL_STATIC_CHAR_METHOD_OFFSET = 123;
        var CALL_STATIC_SHORT_METHOD_OFFSET = 126;
        var CALL_STATIC_INT_METHOD_OFFSET = 129;
        var CALL_STATIC_LONG_METHOD_OFFSET = 132;
        var CALL_STATIC_FLOAT_METHOD_OFFSET = 135;
        var CALL_STATIC_DOUBLE_METHOD_OFFSET = 138;
        var CALL_STATIC_VOID_METHOD_OFFSET = 141;

        var callMethodOffset = {
            'pointer': CALL_OBJECT_METHOD_OFFSET,
            'uint8': CALL_BOOLEAN_METHOD_OFFSET,
            'int8': CALL_BYTE_METHOD_OFFSET,
            'uint16': CALL_CHAR_METHOD_OFFSET,
            'int16': CALL_SHORT_METHOD_OFFSET,
            'int32': CALL_INT_METHOD_OFFSET,
            'int64': CALL_LONG_METHOD_OFFSET,
            'float': CALL_FLOAT_METHOD_OFFSET,
            'double': CALL_DOUBLE_METHOD_OFFSET,
            'void': CALL_VOID_METHOD_OFFSET
        };

        var callStaticMethodOffset = {
            'pointer': CALL_STATIC_OBJECT_METHOD_OFFSET,
            'uint8': CALL_STATIC_BOOLEAN_METHOD_OFFSET,
            'int8': CALL_STATIC_BYTE_METHOD_OFFSET,
            'uint16': CALL_STATIC_CHAR_METHOD_OFFSET,
            'int16': CALL_STATIC_SHORT_METHOD_OFFSET,
            'int32': CALL_STATIC_INT_METHOD_OFFSET,
            'int64': CALL_STATIC_LONG_METHOD_OFFSET,
            'float': CALL_STATIC_FLOAT_METHOD_OFFSET,
            'double': CALL_STATIC_DOUBLE_METHOD_OFFSET,
            'void': CALL_STATIC_VOID_METHOD_OFFSET
        };

        var cachedVtable = null;
        var globalRefs = [];
        WeakRef.bind(Runtime, function dispose() {
            vm.perform(function () {
                var env = vm.getEnv();
                globalRefs.forEach(env.deleteGlobalRef);
                globalRefs = [];
            });
        });

        function register(globalRef) {
            globalRefs.push(globalRef);
            return globalRef;
        };

        function vtable() {
            if (cachedVtable === null) {
                cachedVtable = Memory.readPointer(this.handle);
            }
            return cachedVtable;
        }

        function proxy(offset, retType, argTypes, wrapper) {
            var impl = null;
            return function () {
                if (impl === null) {
                    impl = new NativeFunction(Memory.readPointer(vtable.call(this).add(offset * pointerSize)), retType, argTypes);
                }
                var args = [impl];
                args = args.concat.apply(args, arguments);
                return wrapper.apply(this, args);
            };
        }

        Env.prototype.findClass = proxy(6, 'pointer', ['pointer', 'pointer'], function (impl, name) {
            return impl(this.handle, Memory.allocUtf8String(name));
        });

        Env.prototype.fromReflectedMethod = proxy(7, 'pointer', ['pointer', 'pointer'], function (impl, method) {
            return impl(this.handle, method);
        });

        Env.prototype.getSuperclass = proxy(10, 'pointer', ['pointer', 'pointer'], function (impl, klass) {
            return impl(this.handle, klass);
        });

        Env.prototype.throw = proxy(13, 'int32', ['pointer', 'pointer'], function (impl, obj) {
            return impl(this.handle, obj);
        });

        Env.prototype.exceptionOccurred = proxy(15, 'pointer', ['pointer'], function (impl) {
            return impl(this.handle);
        });

        Env.prototype.exceptionDescribe = proxy(16, 'void', ['pointer'], function (impl) {
            impl(this.handle);
        });

        Env.prototype.exceptionClear = proxy(17, 'void', ['pointer'], function (impl) {
            impl(this.handle);
        });

        Env.prototype.pushLocalFrame = proxy(19, 'int32', ['pointer', 'int32'], function (impl, capacity) {
            return impl(this.handle, capacity);
        });

        Env.prototype.popLocalFrame = proxy(20, 'pointer', ['pointer', 'pointer'], function (impl, result) {
            return impl(this.handle, result);
        });

        Env.prototype.newGlobalRef = proxy(21, 'pointer', ['pointer', 'pointer'], function (impl, obj) {
            return impl(this.handle, obj);
        });

        Env.prototype.deleteGlobalRef = proxy(22, 'void', ['pointer', 'pointer'], function (impl, globalRef) {
            impl(this.handle, globalRef);
        });

        Env.prototype.deleteLocalRef = proxy(23, 'void', ['pointer', 'pointer'], function (impl, localRef) {
            impl(this.handle, localRef);
        });

        Env.prototype.isSameObject = proxy(24, 'uint8', ['pointer', 'pointer', 'pointer'], function (impl, ref1, ref2) {
            return impl(this.handle, ref1, ref2) ? true : false;
        });

        Env.prototype.isInstanceOf = proxy(32, 'uint8', ['pointer', 'pointer', 'pointer'], function (impl, obj, klass) {
            return impl(this.handle, obj, klass) ? true : false;
        });

        Env.prototype.getMethodId = proxy(33, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
            return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
        });

        Env.prototype.getFieldId = proxy(94, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
            return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
        });

        Env.prototype.getIntField = proxy(100, 'int32', ['pointer', 'pointer', 'pointer'], function (impl, obj, fieldId) {
            return impl(this.handle, obj, fieldId);
        });

        Env.prototype.getStaticMethodId = proxy(113, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
            return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
        });

        Env.prototype.getStaticFieldId = proxy(144, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
            return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
        });

        Env.prototype.getStaticIntField = proxy(150, 'int32', ['pointer', 'pointer', 'pointer'], function (impl, obj, fieldId) {
            return impl(this.handle, obj, fieldId);
        });

        Env.prototype.newStringUtf = proxy(167, 'pointer', ['pointer', 'pointer'], function (impl, str) {
            var utf = Memory.allocUtf8String(str);
            return impl(this.handle, utf);
        });

        Env.prototype.getStringUtfChars = proxy(169, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, str) {
            return impl(this.handle, str, NULL);
        });

        Env.prototype.releaseStringUtfChars = proxy(170, 'void', ['pointer', 'pointer', 'pointer'], function (impl, str, utf) {
            impl(this.handle, str, utf);
        });

        Env.prototype.getArrayLength = proxy(171, 'int32', ['pointer', 'pointer'], function (impl, array) {
            return impl(this.handle, array);
        });

        Env.prototype.newObjectArray = proxy(172, 'pointer', ['pointer', 'int32', 'pointer', 'pointer'], function (impl, length, elementClass, initialElement) {
            return impl(this.handle, length, elementClass, initialElement);
        });

        Env.prototype.getObjectArrayElement = proxy(173, 'pointer', ['pointer', 'pointer', 'int32'], function (impl, array, index) {
            return impl(this.handle, array, index);
        });

        Env.prototype.setObjectArrayElement = proxy(174, 'void', ['pointer', 'pointer', 'int32', 'pointer'], function (impl, array, index, value) {
            impl(this.handle, array, index, value);
        });

        var cachedMethods = {};
        var method = function (offset, retType, argTypes) {
            var key = offset + "|" + retType + "|" + argTypes.join(":");
            var m = cachedMethods[key];
            if (!m) {
                m = new NativeFunction(Memory.readPointer(vtable.call(this).add(offset * pointerSize)), retType, ['pointer', 'pointer', 'pointer', '...'].concat(argTypes));
                cachedMethods[key] = m;
            }
            return m;
        };

        Env.prototype.constructor = function (argTypes) {
            return method(CALL_CONSTRUCTOR_METHOD_OFFSET, 'pointer', argTypes);
        };

        Env.prototype.method = function (retType, argTypes) {
            var offset = callMethodOffset[retType];
            if (offset === undefined)
                throw new Error("Unsupported type: " + retType);
            return method(offset, retType, argTypes);
        };

        Env.prototype.staticMethod = function (retType, argTypes) {
            var offset = callStaticMethodOffset[retType];
            if (offset === undefined)
                throw new Error("Unsupported type: " + retType);
            return method(offset, retType, argTypes);
        };

        var javaLangClass = null;
        Env.prototype.javaLangClass = function () {
            if (javaLangClass === null) {
                var handle = this.findClass("java/lang/Class");
                javaLangClass = {
                    handle: register(this.newGlobalRef(handle)),
                    getName: this.getMethodId(handle, "getName", "()Ljava/lang/String;"),
                    getDeclaredConstructors: this.getMethodId(handle, "getDeclaredConstructors", "()[Ljava/lang/reflect/Constructor;"),
                    getDeclaredMethods: this.getMethodId(handle, "getDeclaredMethods", "()[Ljava/lang/reflect/Method;")
                };
                this.deleteLocalRef(handle);
            }
            return javaLangClass;
        };

        var javaLangObject = null;
        Env.prototype.javaLangObject = function () {
            if (javaLangObject === null) {
                var handle = this.findClass("java/lang/Object");
                javaLangObject = {
                    toString: this.getMethodId(handle, "toString", "()Ljava/lang/String;")
                };
                this.deleteLocalRef(handle);
            }
            return javaLangObject;
        };

        var javaLangReflectConstructor = null;
        Env.prototype.javaLangReflectConstructor = function () {
            if (javaLangReflectConstructor === null) {
                var handle = this.findClass("java/lang/reflect/Constructor");
                javaLangReflectConstructor = {
                    getGenericParameterTypes: this.getMethodId(handle, "getGenericParameterTypes", "()[Ljava/lang/reflect/Type;")
                };
                this.deleteLocalRef(handle);
            }
            return javaLangReflectConstructor;
        };

        var javaLangReflectMethod = null;
        Env.prototype.javaLangReflectMethod = function () {
            if (javaLangReflectMethod === null) {
                var handle = this.findClass("java/lang/reflect/Method");
                javaLangReflectMethod = {
                    getName: this.getMethodId(handle, "getName", "()Ljava/lang/String;"),
                    getGenericParameterTypes: this.getMethodId(handle, "getGenericParameterTypes", "()[Ljava/lang/reflect/Type;"),
                    getGenericReturnType: this.getMethodId(handle, "getGenericReturnType", "()Ljava/lang/reflect/Type;"),
                    getModifiers: this.getMethodId(handle, "getModifiers", "()I")
                };
                this.deleteLocalRef(handle);
            }
            return javaLangReflectMethod;
        };

        var javaLangReflectModifier = null;
        Env.prototype.javaLangReflectModifier = function () {
            if (javaLangReflectModifier === null) {
                var handle = this.findClass("java/lang/reflect/Modifier");
                javaLangReflectModifier = {
                    PUBLIC: this.getStaticIntField(handle, this.getStaticFieldId(handle, "PUBLIC", "I")),
                    PRIVATE: this.getStaticIntField(handle, this.getStaticFieldId(handle, "PRIVATE", "I")),
                    PROTECTED: this.getStaticIntField(handle, this.getStaticFieldId(handle, "PROTECTED", "I")),
                    STATIC: this.getStaticIntField(handle, this.getStaticFieldId(handle, "STATIC", "I"))
                };
                this.deleteLocalRef(handle);
            }
            return javaLangReflectModifier;
        };

        var javaLangReflectGenericArrayType = null;
        Env.prototype.javaLangReflectGenericArrayType = function () {
            if (javaLangReflectGenericArrayType === null) {
                var handle = this.findClass("java/lang/reflect/GenericArrayType");
                javaLangReflectGenericArrayType = {
                    handle: register(this.newGlobalRef(handle)),
                    getGenericComponentType: this.getMethodId(handle, "getGenericComponentType", "()Ljava/lang/reflect/Type;")
                };
                this.deleteLocalRef(handle);
            }
            return javaLangReflectGenericArrayType;
        };

        Env.prototype.getClassName = function (klass) {
            var name = this.method('pointer', [])(this.handle, klass, this.javaLangClass().getName);
            var result = this.stringFromJni(name);
            this.deleteLocalRef(name);
            return result;
        };

        Env.prototype.getTypeName = function (type) {
            if (this.isInstanceOf(type, this.javaLangClass().handle)) {
                return this.getClassName(type);
            // } else if (this.isInstanceOf(type, this.javaLangReflectGenericArrayType().handle)) {
            //     return "L";
            } else {
                return "java/lang/Object";
            }
        };

        Env.prototype.stringFromJni = function (str) {
            var utf = this.getStringUtfChars(str);
            var result = Memory.readUtf8String(utf);
            this.releaseStringUtfChars(str, utf);
            return result;
        };
    })();

    var getApi = function () {
        if (_api !== null) {
            return _api;
        }

        var temporaryApi = {};
        var pending = [
            {
                module: "libdvm.so",
                functions: {
                    "_Z20dvmDecodeIndirectRefP6ThreadP8_jobject": ["dvmDecodeIndirectRef", 'pointer', ['pointer', 'pointer']],
                    "_Z15dvmUseJNIBridgeP6MethodPv": ["dvmUseJNIBridge", 'void', ['pointer', 'pointer']]
                },
                variables: {
                    "gDvmJni": function (address) {
                        this.gDvmJni = address;
                    }
                }
            }
        ];
        var remaining = 0;
        pending.forEach(function (api) {
            var pendingFunctions = api.functions;
            var pendingVariables = api.variables;
            remaining += Object.keys(pendingFunctions).length + Object.keys(pendingVariables).length;
            Module.enumerateExports(api.module, {
                onMatch: function (exp) {
                    var name = exp.name;
                    if (exp.type === 'function') {
                        var signature = pendingFunctions[name];
                        if (signature) {
                            if (typeof signature === 'function') {
                                signature.call(temporaryApi, exp.address);
                            } else {
                                temporaryApi[signature[0]] = new NativeFunction(exp.address, signature[1], signature[2]);
                            }
                            delete pendingFunctions[name];
                            remaining--;
                        }
                    } else if (exp.type === 'variable') {
                        var handler = pendingVariables[name];
                        if (handler) {
                            handler.call(temporaryApi, exp.address);
                            delete pendingVariables[name];
                            remaining--;
                        }
                    }
                    if (remaining === 0) {
                        return 'stop';
                    }
                },
                onComplete: function () {
                }
            });
        });
        if (remaining === 0) {
            _api = temporaryApi;
        }

        return _api;
    };

    var checkJniResult = function (name, result) {
        if (result != JNI_OK) {
            throw new Error(name + " failed: " + result);
        }
    };

    var basename = function (className) {
        return className.slice(className.lastIndexOf(".") + 1);
    };

    var writeU16 = function (address, value) {
        Memory.writeU8(address, value & 0xff);
        Memory.writeU8(address.add(1), (value >> 8) & 0xff);
    };

    var writeU32 = function (address, value) {
        Memory.writeU8(address, value & 0xff);
        Memory.writeU8(address.add(1), (value >> 8) & 0xff);
        Memory.writeU8(address.add(2), (value >> 16) & 0xff);
        Memory.writeU8(address.add(3), (value >> 24) & 0xff);
    };

    var writePointer = function (address, value) {
        // TODO: 32-bit only as we expect writePointer to be provided by the Frida runtime sometime soon
        writeU32(address, value.toInt32());
    };

    var memdup = function (mem, size) {
        var result = Memory.alloc(size);
        memcpy(result, mem, size);
        return result;
    };

    var memcpy = function (dst, src, n) {
        for (var i = 0; i !== n; i++) {
            Memory.writeU8(dst.add(i), Memory.readU8(src.add(i)));
        }
    };
}).call(this);

send("*** Dalvik.available: " + Dalvik.available);
Dalvik.perform(function () {
    var Activity = Dalvik.use("android.app.Activity");
    var Exception = Dalvik.use("java.lang.Exception");
    var count = 0;
    Activity.onResume.implementation = function onResume() {
        send("onResume() count=" + count);
        this.onResume();
        count++;
        /*
        if (count === 1) {
            throw Exception.$new("Oh noes");
        }
        if (count === 3) {
            send("enough already!");
            Activity.onResume.implementation = null;
        }
        */
    };
});