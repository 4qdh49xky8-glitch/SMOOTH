import type { SelectorSpec } from "./resolver.js";

/** Sélecteurs de l'adaptateur de démonstration (demo/server.ts). */
export const exampleSelectors = {
  loginEmail: {
    name: "loginEmail",
    description: "Champ e-mail du formulaire de connexion",
    candidates: ['[data-testid="login-email"]', 'input[type="email"]', 'input[name="email"]'],
  },
  loginPassword: {
    name: "loginPassword",
    description: "Champ mot de passe du formulaire de connexion",
    candidates: ['[data-testid="login-password"]', 'input[type="password"]'],
  },
  loginSubmit: {
    name: "loginSubmit",
    description: "Bouton de connexion",
    candidates: ['[data-testid="login-submit"]', 'form button[type="submit"]'],
  },
  accountName: {
    name: "accountName",
    description: "Nom du compte affiché quand on est connecté",
    candidates: ['[data-testid="account-name"]'],
  },
  quantity: {
    name: "quantity",
    description: "Liste déroulante du nombre de billets",
    candidates: ['[data-testid="quantity"]', 'select[name="quantity"]', "select"],
  },
  addToCart: {
    name: "addToCart",
    description: "Bouton « Ajouter au panier » (jamais un bouton de paiement)",
    candidates: ['[data-testid="add-to-cart"]', 'button:has-text("Ajouter au panier")'],
  },
  addError: {
    name: "addError",
    description: "Message d'erreur affiché si les billets ne sont plus disponibles",
    candidates: ['[data-testid="error"]', '[role="alert"]'],
  },
  cartItem: {
    name: "cartItem",
    description: "Ligne d'article dans le panier",
    candidates: ['[data-testid="cart-item"]'],
  },
} satisfies Record<string, SelectorSpec>;
