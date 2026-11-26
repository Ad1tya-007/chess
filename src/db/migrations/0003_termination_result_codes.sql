ALTER TABLE "games" ADD COLUMN "player_result_code" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "termination" text;--> statement-breakpoint
CREATE INDEX "games_player_termination_idx" ON "games" USING btree ("player_id","termination");