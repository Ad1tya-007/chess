CREATE TYPE "public"."game_result" AS ENUM('win', 'loss', 'draw');--> statement-breakpoint
CREATE TYPE "public"."player_color" AS ENUM('white', 'black');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"chesscom_game_url" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"time_class" text,
	"time_control" text,
	"rated" boolean,
	"white_username" text NOT NULL,
	"black_username" text NOT NULL,
	"white_rating" integer,
	"black_rating" integer,
	"result" "game_result" NOT NULL,
	"player_color" "player_color" NOT NULL,
	"opponent_username" text NOT NULL,
	"opponent_rating" integer,
	"eco" text,
	"opening_name" text,
	"pgn" text NOT NULL,
	"san_moves" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chesscom_username" text NOT NULL,
	"profile_url" text,
	"country" text,
	"title" text,
	"name" text,
	"joined_at" timestamp with time zone,
	"last_profile_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_chesscom_username_unique" UNIQUE("chesscom_username"),
	CONSTRAINT "players_chesscom_username_lowercase" CHECK ("players"."chesscom_username" = lower("players"."chesscom_username"))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"archives_checked" integer DEFAULT 0 NOT NULL,
	"games_seen" integer DEFAULT 0 NOT NULL,
	"games_inserted" integer DEFAULT 0 NOT NULL,
	"games_updated" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "games_chesscom_game_url_key" ON "games" USING btree ("chesscom_game_url");--> statement-breakpoint
CREATE INDEX "games_player_played_at_idx" ON "games" USING btree ("player_id","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "games_player_time_class_played_at_idx" ON "games" USING btree ("player_id","time_class","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "games_player_color_idx" ON "games" USING btree ("player_id","player_color");--> statement-breakpoint
CREATE INDEX "games_player_eco_idx" ON "games" USING btree ("player_id","eco");--> statement-breakpoint
CREATE INDEX "sync_runs_player_started_at_idx" ON "sync_runs" USING btree ("player_id","started_at" DESC NULLS LAST);