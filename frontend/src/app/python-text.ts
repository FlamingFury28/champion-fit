// Match Python str.strip(), including whitespace absent from JS trim() and
// excluding the BOM that JS trim() would silently accept.
// eslint-disable-next-line no-control-regex -- Python intentionally strips these ASCII controls.
const pythonWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

export function stripPythonWhitespace(value: string): string {
  return value.replace(pythonWhitespace, '')
}
