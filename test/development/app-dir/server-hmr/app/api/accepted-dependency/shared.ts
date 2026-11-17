export function alpha(input: string) {
  return 'alpha:' + input
}

// The ESM equivalent of `module.hot`.
;(import.meta as any).turbopackHot?.accept()
