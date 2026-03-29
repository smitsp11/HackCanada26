import dns from "node:dns";
import pg from "pg";

dns.setDefaultResultOrder("ipv4first");

const PRODUCTS = [
  // Carrier
  { company: "Carrier", model_number: "59SC5A040S14--10", display_name: "Comfort 95 Gas Furnace", product_type: "furnace" },
  { company: "Carrier", model_number: "59SC6A060M17--16", display_name: "Comfort 96 Condensing Gas Furnace", product_type: "furnace" },
  { company: "Carrier", model_number: "59TP6B060V17--14", display_name: "Performance 96 Gas Furnace", product_type: "furnace" },
  { company: "Carrier", model_number: "24ACC636A003", display_name: "Comfort 16 Central Air Conditioner", product_type: "air_conditioner" },
  { company: "Carrier", model_number: "25HBC536A003", display_name: "Performance 16 Heat Pump", product_type: "heat_pump" },
  { company: "Carrier", model_number: "40MHHQ09-3", display_name: "Ductless High Wall Indoor Unit", product_type: "mini_split" },

  // Lennox
  { company: "Lennox", model_number: "EL296V", display_name: "Elite Series EL296V Gas Furnace", product_type: "furnace" },
  { company: "Lennox", model_number: "SL297NV", display_name: "Dave Lennox Signature Collection Furnace", product_type: "furnace" },
  { company: "Lennox", model_number: "XC25", display_name: "XC25 Air Conditioner", product_type: "air_conditioner" },
  { company: "Lennox", model_number: "XP25", display_name: "XP25 Heat Pump", product_type: "heat_pump" },
  { company: "Lennox", model_number: "ML296V", display_name: "Merit Series ML296V Gas Furnace", product_type: "furnace" },

  // Trane
  { company: "Trane", model_number: "S9V2B060U3PSA", display_name: "S9V2 Gas Furnace", product_type: "furnace" },
  { company: "Trane", model_number: "XR15", display_name: "XR15 Heat Pump", product_type: "heat_pump" },
  { company: "Trane", model_number: "4TTR6024J1000A", display_name: "XR16 Air Conditioner", product_type: "air_conditioner" },
  { company: "Trane", model_number: "TEM6A0C42H31SB", display_name: "Air Handler", product_type: "air_handler" },

  // Rheem
  { company: "Rheem", model_number: "R96VA0602317MSA", display_name: "Classic Plus 96 Gas Furnace", product_type: "furnace" },
  { company: "Rheem", model_number: "RA1636AJ1NA", display_name: "Classic Air Conditioner", product_type: "air_conditioner" },
  { company: "Rheem", model_number: "DERA-04E52JN", display_name: "Prestige Hybrid Water Heater", product_type: "water_heater" },
  { company: "Rheem", model_number: "PROG50-42N RH67", display_name: "ProTerra Plug-In Heat Pump Water Heater", product_type: "water_heater" },

  // Goodman
  { company: "Goodman", model_number: "GMVC960603BN", display_name: "96% AFUE Gas Furnace", product_type: "furnace" },
  { company: "Goodman", model_number: "GSX160361", display_name: "16 SEER Air Conditioner", product_type: "air_conditioner" },
  { company: "Goodman", model_number: "GSZC180361", display_name: "18 SEER2 Heat Pump", product_type: "heat_pump" },

  // Bryant
  { company: "Bryant", model_number: "986TA42060V17", display_name: "Evolution 98 Gas Furnace", product_type: "furnace" },
  { company: "Bryant", model_number: "180BNA036000", display_name: "Evolution Extreme Heat Pump", product_type: "heat_pump" },
  { company: "Bryant", model_number: "126BNA048000", display_name: "Evolution 26 Air Conditioner", product_type: "air_conditioner" },

  // York
  { company: "York", model_number: "TM9V080B12MP11", display_name: "TM9V Gas Furnace", product_type: "furnace" },
  { company: "York", model_number: "YZF036C12S", display_name: "YZF Air Conditioner", product_type: "air_conditioner" },

  // Daikin
  { company: "Daikin", model_number: "DM96VE0603BN", display_name: "96% AFUE Gas Furnace", product_type: "furnace" },
  { company: "Daikin", model_number: "DX16SA0363", display_name: "16 SEER Air Conditioner", product_type: "air_conditioner" },
  { company: "Daikin", model_number: "FTKM12TAVJU", display_name: "Quaternity Wall Mount", product_type: "mini_split" },

  // Bosch
  { company: "Bosch", model_number: "BGH96M060B3A", display_name: "96% AFUE Gas Furnace", product_type: "furnace" },
  { company: "Bosch", model_number: "BVA-24WN1-M20", display_name: "Climate 5000 Mini Split", product_type: "mini_split" },

  // Amana
  { company: "Amana", model_number: "AMVC960603BN", display_name: "96% AFUE Gas Furnace", product_type: "furnace" },
  { company: "Amana", model_number: "ASX160361", display_name: "16 SEER Air Conditioner", product_type: "air_conditioner" },

  // Whirlpool
  { company: "Whirlpool", model_number: "WFG505M0BS", display_name: "Freestanding Gas Range", product_type: "range" },
  { company: "Whirlpool", model_number: "WDT750SAHZ", display_name: "Dishwasher with Third Level Rack", product_type: "dishwasher" },
  { company: "Whirlpool", model_number: "WTW5000DW", display_name: "Top Load Washer", product_type: "washer" },

  // GE
  { company: "GE", model_number: "GFE28GYNFS", display_name: "French Door Refrigerator", product_type: "refrigerator" },
  { company: "GE", model_number: "JB655YKFS", display_name: "Electric Range", product_type: "range" },
  { company: "GE", model_number: "GDT665SSNSS", display_name: "Dishwasher with Hidden Controls", product_type: "dishwasher" },

  // Samsung
  { company: "Samsung", model_number: "RF28T5001SR", display_name: "French Door Refrigerator", product_type: "refrigerator" },
  { company: "Samsung", model_number: "NX60A6511SS", display_name: "Smart Freestanding Gas Range", product_type: "range" },
  { company: "Samsung", model_number: "WF45R6100AW", display_name: "Front Load Washer", product_type: "washer" },

  // LG
  { company: "LG", model_number: "LRFXS2503S", display_name: "French Door Refrigerator", product_type: "refrigerator" },
  { company: "LG", model_number: "LDT5678SS", display_name: "Top Control Dishwasher", product_type: "dishwasher" },
  { company: "LG", model_number: "WM4000HWA", display_name: "Front Load Washer", product_type: "washer" },
];

async function seed() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  for (const p of PRODUCTS) {
    await client.query(
      `INSERT INTO products (company, model_number, display_name, product_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [p.company, p.model_number, p.display_name, p.product_type],
    );
  }

  console.log(`Seeded ${PRODUCTS.length} products.`);
  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
