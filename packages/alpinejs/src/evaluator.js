import { closestDataStack, mergeProxies } from './scope'
import { injectMagics } from './magics'
import { tryCatch, handleError } from './utils/error'

export function evaluate(el, expression, extras = {}) {
    let result

    evaluateLater(el, expression)(value => result = value, extras)

    return result
}

export function evaluateLater(...args) {
    return theEvaluatorFunction(...args)
}

let theEvaluatorFunction = normalEvaluator

export function setEvaluator(newEvaluator) {
    theEvaluatorFunction = newEvaluator
}

export function normalEvaluator(el, expression) {
    let overriddenMagics = {}

    injectMagics(overriddenMagics, el)

    let dataStack = [overriddenMagics, ...closestDataStack(el)]

    if (typeof expression === 'function') {
        return generateEvaluatorFromFunction(dataStack, expression)
    }

    let evaluator = generateEvaluatorFromString(dataStack, expression, el)

    return tryCatch.bind(null, el, expression, evaluator)
}

export function generateEvaluatorFromFunction(dataStack, func) {
    return (receiver = () => {}, { scope = {}, params = [] } = {}) => {
        let result = func.apply(mergeProxies([scope, ...dataStack]), params)

        runIfTypeOfFunction(receiver, result)
    }
}

let evaluatorMemo = {}

function generateFunctionFromString(expression, el) {
    if (evaluatorMemo[expression]) {
        return evaluatorMemo[expression]
    }

    let AsyncFunction = Object.getPrototypeOf(async function(){}).constructor

    // Some expressions that are useful in Alpine are not valid as the right side of an expression.
    // Here we'll detect if the expression isn't valid for an assignement and wrap it in a self-
    // calling function so that we don't throw an error AND a "return" statement can b e used.
    let rightSideSafeExpression = 0
        // Support expressions starting with "if" statements like: "if (...) doSomething()"
        || /^[\n\s]*if.*\(.*\)/.test(expression)
        // Support expressions starting with "let/const" like: "let foo = 'bar'"
        || /^(let|const)/.test(expression)
            ? `(() => { ${expression} })()`
            : expression

    const safeAsyncFunction = () => {
        try {
            return new AsyncFunction(['__self', 'scope'], `with (scope) { __self.result = ${rightSideSafeExpression} }; __self.finished = true; return __self.result;`)
        } catch ( error ) {
            handleError( error, el, expression )
            return Promise.resolve()
        }
    }
    let func = safeAsyncFunction()

    evaluatorMemo[expression] = func

    return func
}

function generateEvaluatorFromString(dataStack, expression, el) {
    let func = generateFunctionFromString(expression, el)

    return (receiver = () => {}, { scope = {}, params = [] } = {}) => {
        func.result = undefined
        func.finished = false

        // Run the function.

        let completeScope = mergeProxies([ scope, ...dataStack ])

        if( typeof func === 'function' ) {
            let promise = func(func, completeScope).catch((error) => handleError(error, el, expression))

            // Check if the function ran synchronously,
            if (func.finished) {
                // Return the immediate result.
                runIfTypeOfFunction(receiver, func.result, completeScope, params, el)
            } else {
                // If not, return the result when the promise resolves.
                promise.then(result => {
                    runIfTypeOfFunction(receiver, result, completeScope, params, el)
                }).catch( error => handleError( error, el, expression ) )
            }
        }
    }
}

export function runIfTypeOfFunction(receiver, value, scope, params, el) {
    if (typeof value === 'function') {
        let result = value.apply(scope, params)

        if (result instanceof Promise) {
            result.then(i => runIfTypeOfFunction(receiver, i, scope, params)).catch( error => handleError( error, el, value ) )
        } else {
            receiver(result)
        }
    } else {
        receiver(value)
    }
}
