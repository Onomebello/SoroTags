import 'cypress-axe'

// index.html ships a CSP meta tag with `script-src 'self'`, which blocks the
// eval cy.injectAxe() uses to load axe-core. Remove it from the page served
// to Cypress only; the app itself keeps its policy.
beforeEach(() => {
  cy.intercept({ method: 'GET', url: '/' }, (req) => {
    req.continue((res) => {
      res.body = res.body.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        '',
      )
    })
  })
})
