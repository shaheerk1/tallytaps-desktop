-- A delivery note is either a stock receipt or a purchase record.
--
-- A shop in perishables counts nothing daily: damage, repacks and loose sales
-- move the real figures hour by hour, and a stock number kept to three decimals
-- is precise and wrong by the afternoon. What that shop does need from a GRN is
-- the money: what was bought, at what price, from whom, and what is still owed,
-- because it settles those every day.
--
-- So a GRN now says which of the two it is:
--
--   stock_receipt   what it has always been. Goods go into stock, the lot can
--                   be sold from, and the purchase sits in stock value (1200)
--                   until the goods sell.
--   purchase_record the purchase and the amount due are recorded in full; no
--                   stock is created, the lot holds nothing to sell, and the
--                   purchase is charged straight to goods cost (5000).
--
-- The second is periodic inventory rather than perpetual: both are proper
-- methods, and the one a shop uses is written on the document so an old GRN
-- always reads back the way it was posted. The mode cannot be changed after
-- posting; remove the GRN and enter it again.
--
-- Only an owned purchase may be a purchase record. A consignment supplier is
-- paid out of what sold, and that is worked out from sales allocated to their
-- lot, so consignment must track stock or the supplier would never be owed.
ALTER TABLE goods_receipts
  ADD COLUMN stock_mode ENUM('stock_receipt','purchase_record') NOT NULL DEFAULT 'stock_receipt' AFTER document_type;

-- The lot keeps the answer with it, the way it keeps its uoms and its terms:
-- a lot of a purchase record is born empty and is never sellable, and reports
-- can say so instead of showing it as a lot that sold out.
ALTER TABLE inventory_lots
  ADD COLUMN stock_tracked TINYINT(1) NOT NULL DEFAULT 1 AFTER ownership_model;
