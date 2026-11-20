CREATE TABLE "chesscom_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"games_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chesscom_archives_month_range" CHECK ("chesscom_archives"."month" between 1 and 12),
	CONSTRAINT "chesscom_archives_year_range" CHECK ("chesscom_archives"."year" between 2000 and 2100)
);
--> statement-breakpoint
DROP INDEX "games_chesscom_game_url_key";--> statement-breakpoint
ALTER TABLE "chesscom_archives" ADD CONSTRAINT "chesscom_archives_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chesscom_archives_player_month_key" ON "chesscom_archives" USING btree ("player_id","year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "games_player_game_url_key" ON "games" USING btree ("player_id","chesscom_game_url");