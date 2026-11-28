describe('Payment form accessibility', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.get('form.payment-form').should('be.visible')
    cy.injectAxe()
  })

  it('reports no axe violations on the payment form', () => {
    cy.checkA11y('form.payment-form')
  })

  it('reaches recipient, amount and Send Payment with Tab in that order', () => {
    cy.get('#recipient').focus()
    cy.press(Cypress.Keyboard.Keys.TAB)
    cy.focused().should('have.id', 'amount')
    cy.press(Cypress.Keyboard.Keys.TAB)
    cy.focused().should('have.attr', 'type', 'submit').and('contain.text', 'Send Payment')
  })

  it('announces the result when the form is submitted with Enter', () => {
    cy.get('#amount').type('{enter}')
    cy.get('form.payment-form [role="status"]')
      .should('have.attr', 'aria-live', 'polite')
      .and('contain.text', 'Enter a recipient and an amount greater than zero.')
  })
})

describe('Wallet dialog accessibility', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.injectAxe()
    cy.contains('button', 'Connect Wallet').click()
    cy.contains('#wallet-menu-dropdown button', 'Connect').click()
    cy.get('[role="dialog"]').should('be.visible')
    cy.contains('[role="dialog"] button', 'Freighter')
  })

  it('reports no axe violations in the wallet dialog', () => {
    cy.checkA11y('[role="dialog"]')
  })

  it('keeps Tab inside the dialog', () => {
    cy.get('[role="dialog"] button').last().focus()
    cy.press(Cypress.Keyboard.Keys.TAB)
    cy.focused().should('have.attr', 'aria-label', 'Close wallet selection')
  })

  it('closes on Escape and returns focus to the wallet button', () => {
    cy.get('body').type('{esc}')
    cy.get('[role="dialog"]').should('not.exist')
    cy.focused().should('have.class', 'wallet-menu-trigger')
  })
})
