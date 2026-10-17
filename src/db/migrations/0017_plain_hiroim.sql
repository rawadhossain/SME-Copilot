CREATE TABLE "document_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid,
	"bill_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_on" date NOT NULL,
	"transaction_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "document_payments_one_document" CHECK (("document_payments"."invoice_id" is null) <> ("document_payments"."bill_id" is null)),
	CONSTRAINT "document_payments_positive" CHECK ("document_payments"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "counted_in" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "counted_in" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_payments" ADD CONSTRAINT "document_payments_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_payments_invoice_idx" ON "document_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "document_payments_bill_idx" ON "document_payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "document_payments_txn_idx" ON "document_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_supplier_reference_idx" ON "bills" USING btree ("business_id","supplier_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_number_idx" ON "invoices" USING btree ("business_id","customer_id","number");--> statement-breakpoint
GRANT SELECT, INSERT ON document_payments TO sme_app;--> statement-breakpoint
GRANT UPDATE (voided_at, void_reason) ON document_payments TO sme_app;
