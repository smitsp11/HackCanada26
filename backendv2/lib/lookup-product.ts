import pool from "./db";

export interface Product {
  id: number;
  company: string;
  model_number: string;
  display_name: string | null;
  product_type: string | null;
}

/**
 * Look up a product by company and/or model number.
 * Tries exact (case-insensitive) match first, then partial model match.
 */
export async function lookupProduct(
  company?: string,
  modelNumber?: string,
): Promise<Product | null> {
  if (!company && !modelNumber) return null;

  // 1. Exact match on both fields (if both provided)
  if (company && modelNumber) {
    const { rows } = await pool.query<Product>(
      `SELECT id, company, model_number, display_name, product_type
       FROM products
       WHERE LOWER(company) = LOWER($1) AND LOWER(model_number) = LOWER($2)
       LIMIT 1`,
      [company, modelNumber],
    );
    if (rows.length > 0) return rows[0];
  }

  // 2. Match on model_number alone
  if (modelNumber) {
    const { rows } = await pool.query<Product>(
      `SELECT id, company, model_number, display_name, product_type
       FROM products
       WHERE LOWER(model_number) = LOWER($1)
       LIMIT 1`,
      [modelNumber],
    );
    if (rows.length > 0) return rows[0];
  }

  // 3. Partial / LIKE match on model_number
  if (modelNumber && modelNumber.length >= 4) {
    const { rows } = await pool.query<Product>(
      `SELECT id, company, model_number, display_name, product_type
       FROM products
       WHERE LOWER(model_number) LIKE '%' || LOWER($1) || '%'
       LIMIT 1`,
      [modelNumber],
    );
    if (rows.length > 0) return rows[0];
  }

  // 4. Match on company alone (return first product for that brand)
  if (company) {
    const { rows } = await pool.query<Product>(
      `SELECT id, company, model_number, display_name, product_type
       FROM products
       WHERE LOWER(company) = LOWER($1)
       LIMIT 1`,
      [company],
    );
    if (rows.length > 0) return rows[0];
  }

  return null;
}
