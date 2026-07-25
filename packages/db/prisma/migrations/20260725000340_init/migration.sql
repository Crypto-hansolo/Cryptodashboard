-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('MARKET_DATA', 'DERIVATIVES', 'DEX', 'NEWS', 'BLOG', 'SOCIAL', 'FORUM', 'VIDEO', 'ONCHAIN', 'ANALYTICS', 'CODE', 'GOVERNANCE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "IdentifierKind" AS ENUM ('COINGECKO', 'COINMARKETCAP', 'SYMBOL', 'CONTRACT', 'SLUG', 'CHAIN_NATIVE');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('PRICE_ACTION', 'MARKET_STRUCTURE', 'DERIVATIVES', 'LIQUIDATION', 'EXCHANGE_LISTING', 'NEWS', 'SOCIAL', 'ONCHAIN', 'WHALE', 'DEVELOPMENT', 'GOVERNANCE', 'TOKENOMICS', 'SECURITY', 'REGULATORY', 'PARTNERSHIP', 'MACRO', 'OTHER');

-- CreateEnum
CREATE TYPE "SentimentLabel" AS ENUM ('VERY_BEARISH', 'BEARISH', 'NEUTRAL', 'BULLISH', 'VERY_BULLISH');

-- CreateEnum
CREATE TYPE "ImpactLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('ONE_MINUTE', 'FIVE_MINUTES', 'FIFTEEN_MINUTES', 'ONE_HOUR', 'FOUR_HOURS', 'ONE_DAY', 'ONE_WEEK');

-- CreateEnum
CREATE TYPE "OptionKind" AS ENUM ('CALL', 'PUT');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "VenueKind" AS ENUM ('CEX', 'DEX');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('X', 'REDDIT', 'TELEGRAM', 'DISCORD', 'FARCASTER', 'LENS', 'YOUTUBE', 'TIKTOK', 'GITHUB');

-- CreateEnum
CREATE TYPE "AuthorRole" AS ENUM ('FOUNDER', 'CORE_DEV', 'TEAM', 'COMMUNITY_MANAGER', 'INFLUENCER', 'EXCHANGE', 'MEDIA', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "WalletLabel" AS ENUM ('EXCHANGE', 'TREASURY', 'FOUNDATION', 'TEAM', 'WHALE', 'BRIDGE', 'CONTRACT', 'BURN', 'STAKING', 'MARKET_MAKER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OnchainEventType" AS ENUM ('WHALE_TRANSFER', 'EXCHANGE_INFLOW', 'EXCHANGE_OUTFLOW', 'TREASURY_MOVEMENT', 'FOUNDATION_MOVEMENT', 'TOKEN_UNLOCK', 'BRIDGE_TRANSFER', 'STAKE', 'UNSTAKE', 'BURN', 'MINT', 'CONTRACT_UPGRADE', 'CONTRACT_DEPLOY', 'GOVERNANCE_ACTION', 'LIQUIDITY_ADD', 'LIQUIDITY_REMOVE');

-- CreateEnum
CREATE TYPE "GithubActivityType" AS ENUM ('COMMIT', 'RELEASE', 'PULL_REQUEST', 'ISSUE', 'FORK', 'STAR_MILESTONE');

-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('PENDING', 'ACTIVE', 'PASSED', 'FAILED', 'QUEUED', 'EXECUTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('DESKTOP', 'DISCORD', 'TELEGRAM', 'EMAIL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('HOURLY', 'MORNING', 'DAILY', 'WEEKLY', 'MONTHLY', 'PORTFOLIO', 'NARRATIVE', 'ON_DEMAND');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "homepageUrl" TEXT,
    "credibility" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coin" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coingeckoId" TEXT,
    "coinmarketcapId" TEXT,
    "chain" TEXT,
    "imageUrl" TEXT,
    "description" TEXT,
    "websiteUrl" TEXT,
    "githubRepos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "twitterHandle" TEXT,
    "subreddit" TEXT,
    "snapshotSpaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "marketCapRank" INTEGER,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinIdentifier" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "kind" "IdentifierKind" NOT NULL,
    "value" TEXT NOT NULL,
    "chain" TEXT,

    CONSTRAINT "CoinIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinContract" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "decimals" INTEGER,
    "isNative" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CoinContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioHolding" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "costBasis" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinTag" (
    "tagId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,

    CONSTRAINT "CoinTag_pkey" PRIMARY KEY ("tagId","coinId")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coinId" TEXT,
    "sourceId" TEXT NOT NULL,
    "category" "EventCategory" NOT NULL,
    "subtype" TEXT,
    "headline" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "author" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "clusterId" TEXT,
    "summary" TEXT,
    "explanation" TEXT,
    "sentiment" "SentimentLabel",
    "sentimentScore" DOUBLE PRECISION,
    "importance" INTEGER,
    "confidence" INTEGER,
    "impact" "ImpactLevel",
    "narratives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isFud" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "enrichedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "relatedCoinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventEmbedding" (
    "eventId" TEXT NOT NULL,
    "vector" vector(768) NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventEmbedding_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "marketCapUsd" DOUBLE PRECISION,
    "fdvUsd" DOUBLE PRECISION,
    "volume24hUsd" DOUBLE PRECISION,
    "circulatingSupply" DOUBLE PRECISION,
    "totalSupply" DOUBLE PRECISION,
    "maxSupply" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "priceChange1hPct" DOUBLE PRECISION,
    "priceChange24hPct" DOUBLE PRECISION,
    "priceChange7dPct" DOUBLE PRECISION,
    "priceChange30dPct" DOUBLE PRECISION,
    "marketCapRank" INTEGER,
    "athUsd" DOUBLE PRECISION,
    "atlUsd" DOUBLE PRECISION,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OhlcvCandle" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "quoteVolume" DOUBLE PRECISION,
    "trades" INTEGER,

    CONSTRAINT "OhlcvCandle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivativesSnapshot" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "instrument" TEXT NOT NULL,
    "fundingRate" DOUBLE PRECISION,
    "nextFundingAt" TIMESTAMP(3),
    "openInterest" DOUBLE PRECISION,
    "openInterestUsd" DOUBLE PRECISION,
    "markPrice" DOUBLE PRECISION,
    "indexPrice" DOUBLE PRECISION,
    "longShortRatio" DOUBLE PRECISION,
    "volume24hUsd" DOUBLE PRECISION,

    CONSTRAINT "DerivativesSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionsSnapshot" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "strike" DOUBLE PRECISION NOT NULL,
    "kind" "OptionKind" NOT NULL,
    "openInterest" DOUBLE PRECISION,
    "impliedVolatility" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,

    CONSTRAINT "OptionsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liquidation" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "instrument" TEXT NOT NULL,
    "side" "PositionSide" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "valueUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Liquidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "venue" TEXT NOT NULL,
    "venueKind" "VenueKind" NOT NULL,
    "pair" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "valueUsd" DOUBLE PRECISION NOT NULL,
    "txHash" TEXT,
    "trader" TEXT,
    "chain" TEXT,
    "isWhale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingPair" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "venueKind" "VenueKind" NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "volume24hUsd" DOUBLE PRECISION,
    "spread" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeListing" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "venueKind" "VenueKind" NOT NULL,
    "symbol" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT,

    CONSTRAINT "ExchangeListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidityPool" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "chain" TEXT NOT NULL,
    "dex" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "pairLabel" TEXT NOT NULL,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "volume24hUsd" DOUBLE PRECISION,
    "priceUsd" DOUBLE PRECISION,
    "buys24h" INTEGER,
    "sells24h" INTEGER,

    CONSTRAINT "LiquidityPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsArticle" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,
    "excerpt" TEXT,
    "content" TEXT,
    "imageUrl" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "NewsArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAuthor" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "AuthorRole" NOT NULL DEFAULT 'ANONYMOUS',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "followers" INTEGER,
    "affiliatedCoinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAuthor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorHandle" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "url" TEXT,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "reposts" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER,
    "engagementScore" DOUBLE PRECISION,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialMetric" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "mentions" INTEGER NOT NULL,
    "uniqueAuthors" INTEGER NOT NULL,
    "totalEngagement" DOUBLE PRECISION NOT NULL,
    "sentimentScore" DOUBLE PRECISION,
    "velocity" DOUBLE PRECISION,
    "trendingScore" DOUBLE PRECISION,
    "topHashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SocialMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" "WalletLabel" NOT NULL DEFAULT 'UNKNOWN',
    "entityName" TEXT,
    "coinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnchainEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "type" "OnchainEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "chain" TEXT NOT NULL,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "fromLabel" "WalletLabel",
    "toLabel" "WalletLabel",
    "amount" DOUBLE PRECISION,
    "amountUsd" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "OnchainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnchainMetric" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,

    CONSTRAINT "OnchainMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubActivity" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "type" "GithubActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "url" TEXT,
    "additions" INTEGER,
    "deletions" INTEGER,

    CONSTRAINT "GithubActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubRepoSnapshot" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "stars" INTEGER NOT NULL,
    "forks" INTEGER NOT NULL,
    "openIssues" INTEGER NOT NULL,
    "watchers" INTEGER,
    "commits30d" INTEGER,
    "contributors30d" INTEGER,
    "activityScore" DOUBLE PRECISION,

    CONSTRAINT "GithubRepoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceProposal" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "space" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "author" TEXT,
    "state" "ProposalState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "url" TEXT,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scores" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "totalVotes" INTEGER,
    "quorum" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenUnlock" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "unlockAt" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountUsd" DOUBLE PRECISION,
    "pctOfCirculating" DOUBLE PRECISION,
    "category" TEXT,
    "isCliff" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenomicsSnapshot" (
    "id" TEXT NOT NULL,
    "coinId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "inflationRate" DOUBLE PRECISION,
    "emissions24h" DOUBLE PRECISION,
    "burned24h" DOUBLE PRECISION,
    "stakingApy" DOUBLE PRECISION,
    "stakedSupply" DOUBLE PRECISION,
    "stakedPct" DOUBLE PRECISION,
    "validatorCount" INTEGER,
    "treasuryUsd" DOUBLE PRECISION,
    "tvlUsd" DOUBLE PRECISION,

    CONSTRAINT "TokenomicsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "channels" "NotificationChannel"[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "lastTriggeredAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertTrigger" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "eventId" TEXT,
    "coinId" TEXT,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "observedValue" DOUBLE PRECISION,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AlertTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "coinId" TEXT,
    "portfolioId" TEXT,
    "citedEventIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectorRun" (
    "id" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "status" "RunStatus" NOT NULL,
    "itemsFetched" INTEGER NOT NULL DEFAULT 0,
    "itemsIngested" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "error" TEXT,
    "coinIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "CollectorRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorState" (
    "connectorKey" TEXT NOT NULL,
    "lastItemAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorState_pkey" PRIMARY KEY ("connectorKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_key_key" ON "Source"("key");

-- CreateIndex
CREATE INDEX "Source_kind_isEnabled_idx" ON "Source"("kind", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "Coin_slug_key" ON "Coin"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Coin_coingeckoId_key" ON "Coin"("coingeckoId");

-- CreateIndex
CREATE UNIQUE INDEX "Coin_coinmarketcapId_key" ON "Coin"("coinmarketcapId");

-- CreateIndex
CREATE INDEX "Coin_symbol_idx" ON "Coin"("symbol");

-- CreateIndex
CREATE INDEX "Coin_marketCapRank_idx" ON "Coin"("marketCapRank");

-- CreateIndex
CREATE INDEX "Coin_isActive_marketCapRank_idx" ON "Coin"("isActive", "marketCapRank");

-- CreateIndex
CREATE INDEX "CoinIdentifier_coinId_idx" ON "CoinIdentifier"("coinId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinIdentifier_kind_value_chain_key" ON "CoinIdentifier"("kind", "value", "chain");

-- CreateIndex
CREATE INDEX "CoinContract_coinId_idx" ON "CoinContract"("coinId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinContract_chain_address_key" ON "CoinContract"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Watchlist_userId_idx" ON "Watchlist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_name_key" ON "Watchlist"("userId", "name");

-- CreateIndex
CREATE INDEX "WatchlistItem_coinId_idx" ON "WatchlistItem"("coinId");

-- CreateIndex
CREATE INDEX "WatchlistItem_watchlistId_isPinned_position_idx" ON "WatchlistItem"("watchlistId", "isPinned", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_watchlistId_coinId_key" ON "WatchlistItem"("watchlistId", "coinId");

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_userId_name_key" ON "Portfolio"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioHolding_portfolioId_coinId_key" ON "PortfolioHolding"("portfolioId", "coinId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_name_key" ON "Tag"("userId", "name");

-- CreateIndex
CREATE INDEX "CoinTag_coinId_idx" ON "CoinTag"("coinId");

-- CreateIndex
CREATE INDEX "Event_occurredAt_id_idx" ON "Event"("occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Event_coinId_occurredAt_idx" ON "Event"("coinId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_category_occurredAt_idx" ON "Event"("category", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_sourceId_occurredAt_idx" ON "Event"("sourceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_importance_occurredAt_idx" ON "Event"("importance" DESC, "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_clusterId_idx" ON "Event"("clusterId");

-- CreateIndex
CREATE INDEX "Event_enrichedAt_occurredAt_idx" ON "Event"("enrichedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_ingestedAt_idx" ON "Event"("ingestedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Event_sourceId_dedupeHash_key" ON "Event"("sourceId", "dedupeHash");

-- CreateIndex
CREATE INDEX "MarketSnapshot_coinId_observedAt_idx" ON "MarketSnapshot"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "MarketSnapshot_observedAt_idx" ON "MarketSnapshot"("observedAt");

-- CreateIndex
CREATE INDEX "OhlcvCandle_coinId_interval_openTime_idx" ON "OhlcvCandle"("coinId", "interval", "openTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OhlcvCandle_coinId_sourceId_interval_openTime_key" ON "OhlcvCandle"("coinId", "sourceId", "interval", "openTime");

-- CreateIndex
CREATE INDEX "DerivativesSnapshot_coinId_observedAt_idx" ON "DerivativesSnapshot"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "DerivativesSnapshot_coinId_instrument_observedAt_idx" ON "DerivativesSnapshot"("coinId", "instrument", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "OptionsSnapshot_coinId_observedAt_idx" ON "OptionsSnapshot"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "OptionsSnapshot_coinId_expiry_idx" ON "OptionsSnapshot"("coinId", "expiry");

-- CreateIndex
CREATE INDEX "Liquidation_coinId_occurredAt_idx" ON "Liquidation"("coinId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Liquidation_valueUsd_idx" ON "Liquidation"("valueUsd" DESC);

-- CreateIndex
CREATE INDEX "Trade_coinId_occurredAt_idx" ON "Trade"("coinId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Trade_isWhale_valueUsd_occurredAt_idx" ON "Trade"("isWhale", "valueUsd" DESC, "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Trade_txHash_idx" ON "Trade"("txHash");

-- CreateIndex
CREATE INDEX "TradingPair_coinId_isActive_idx" ON "TradingPair"("coinId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TradingPair_venue_symbol_key" ON "TradingPair"("venue", "symbol");

-- CreateIndex
CREATE INDEX "ExchangeListing_detectedAt_idx" ON "ExchangeListing"("detectedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeListing_coinId_venue_symbol_key" ON "ExchangeListing"("coinId", "venue", "symbol");

-- CreateIndex
CREATE INDEX "LiquidityPool_coinId_observedAt_idx" ON "LiquidityPool"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "LiquidityPool_poolAddress_observedAt_idx" ON "LiquidityPool"("poolAddress", "observedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "NewsArticle_eventId_key" ON "NewsArticle"("eventId");

-- CreateIndex
CREATE INDEX "NewsArticle_publishedAt_idx" ON "NewsArticle"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "NewsArticle_url_idx" ON "NewsArticle"("url");

-- CreateIndex
CREATE INDEX "SocialAuthor_platform_handle_idx" ON "SocialAuthor"("platform", "handle");

-- CreateIndex
CREATE INDEX "SocialAuthor_role_idx" ON "SocialAuthor"("role");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAuthor_platform_externalId_key" ON "SocialAuthor"("platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_eventId_key" ON "SocialPost"("eventId");

-- CreateIndex
CREATE INDEX "SocialPost_postedAt_idx" ON "SocialPost"("postedAt" DESC);

-- CreateIndex
CREATE INDEX "SocialPost_authorId_postedAt_idx" ON "SocialPost"("authorId", "postedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_platform_externalId_key" ON "SocialPost"("platform", "externalId");

-- CreateIndex
CREATE INDEX "SocialMetric_coinId_platform_observedAt_idx" ON "SocialMetric"("coinId", "platform", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "SocialMetric_trendingScore_idx" ON "SocialMetric"("trendingScore" DESC);

-- CreateIndex
CREATE INDEX "Wallet_label_idx" ON "Wallet"("label");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_chain_address_key" ON "Wallet"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "OnchainEvent_eventId_key" ON "OnchainEvent"("eventId");

-- CreateIndex
CREATE INDEX "OnchainEvent_coinId_occurredAt_idx" ON "OnchainEvent"("coinId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "OnchainEvent_coinId_type_occurredAt_idx" ON "OnchainEvent"("coinId", "type", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "OnchainEvent_amountUsd_idx" ON "OnchainEvent"("amountUsd" DESC);

-- CreateIndex
CREATE INDEX "OnchainEvent_txHash_idx" ON "OnchainEvent"("txHash");

-- CreateIndex
CREATE INDEX "OnchainMetric_coinId_metric_observedAt_idx" ON "OnchainMetric"("coinId", "metric", "observedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OnchainMetric_coinId_sourceId_metric_observedAt_key" ON "OnchainMetric"("coinId", "sourceId", "metric", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GithubActivity_eventId_key" ON "GithubActivity"("eventId");

-- CreateIndex
CREATE INDEX "GithubActivity_coinId_occurredAt_idx" ON "GithubActivity"("coinId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "GithubActivity_repo_occurredAt_idx" ON "GithubActivity"("repo", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GithubActivity_repo_type_externalId_key" ON "GithubActivity"("repo", "type", "externalId");

-- CreateIndex
CREATE INDEX "GithubRepoSnapshot_coinId_observedAt_idx" ON "GithubRepoSnapshot"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "GithubRepoSnapshot_repo_observedAt_idx" ON "GithubRepoSnapshot"("repo", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "GithubRepoSnapshot_activityScore_idx" ON "GithubRepoSnapshot"("activityScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceProposal_eventId_key" ON "GovernanceProposal"("eventId");

-- CreateIndex
CREATE INDEX "GovernanceProposal_coinId_createdAt_idx" ON "GovernanceProposal"("coinId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GovernanceProposal_state_endsAt_idx" ON "GovernanceProposal"("state", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceProposal_space_externalId_key" ON "GovernanceProposal"("space", "externalId");

-- CreateIndex
CREATE INDEX "TokenUnlock_unlockAt_idx" ON "TokenUnlock"("unlockAt");

-- CreateIndex
CREATE UNIQUE INDEX "TokenUnlock_coinId_unlockAt_category_key" ON "TokenUnlock"("coinId", "unlockAt", "category");

-- CreateIndex
CREATE INDEX "TokenomicsSnapshot_coinId_observedAt_idx" ON "TokenomicsSnapshot"("coinId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_userId_idx" ON "Alert"("userId");

-- CreateIndex
CREATE INDEX "Alert_isEnabled_idx" ON "Alert"("isEnabled");

-- CreateIndex
CREATE INDEX "AlertTrigger_alertId_triggeredAt_idx" ON "AlertTrigger"("alertId", "triggeredAt" DESC);

-- CreateIndex
CREATE INDEX "AlertTrigger_triggeredAt_idx" ON "AlertTrigger"("triggeredAt" DESC);

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_triggerId_idx" ON "NotificationDelivery"("triggerId");

-- CreateIndex
CREATE INDEX "Report_kind_createdAt_idx" ON "Report"("kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Report_coinId_kind_createdAt_idx" ON "Report"("coinId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CollectorRun_connectorKey_startedAt_idx" ON "CollectorRun"("connectorKey", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CollectorRun_startedAt_idx" ON "CollectorRun"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "CollectorRun_status_startedAt_idx" ON "CollectorRun"("status", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "CoinIdentifier" ADD CONSTRAINT "CoinIdentifier_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinContract" ADD CONSTRAINT "CoinContract_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioHolding" ADD CONSTRAINT "PortfolioHolding_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioHolding" ADD CONSTRAINT "PortfolioHolding_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinTag" ADD CONSTRAINT "CoinTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinTag" ADD CONSTRAINT "CoinTag_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventEmbedding" ADD CONSTRAINT "EventEmbedding_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OhlcvCandle" ADD CONSTRAINT "OhlcvCandle_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OhlcvCandle" ADD CONSTRAINT "OhlcvCandle_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivativesSnapshot" ADD CONSTRAINT "DerivativesSnapshot_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivativesSnapshot" ADD CONSTRAINT "DerivativesSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionsSnapshot" ADD CONSTRAINT "OptionsSnapshot_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionsSnapshot" ADD CONSTRAINT "OptionsSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidation" ADD CONSTRAINT "Liquidation_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidation" ADD CONSTRAINT "Liquidation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingPair" ADD CONSTRAINT "TradingPair_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingPair" ADD CONSTRAINT "TradingPair_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeListing" ADD CONSTRAINT "ExchangeListing_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeListing" ADD CONSTRAINT "ExchangeListing_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityPool" ADD CONSTRAINT "LiquidityPool_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityPool" ADD CONSTRAINT "LiquidityPool_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsArticle" ADD CONSTRAINT "NewsArticle_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsArticle" ADD CONSTRAINT "NewsArticle_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "SocialAuthor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMetric" ADD CONSTRAINT "SocialMetric_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainEvent" ADD CONSTRAINT "OnchainEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainEvent" ADD CONSTRAINT "OnchainEvent_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainEvent" ADD CONSTRAINT "OnchainEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainMetric" ADD CONSTRAINT "OnchainMetric_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainMetric" ADD CONSTRAINT "OnchainMetric_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubActivity" ADD CONSTRAINT "GithubActivity_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubActivity" ADD CONSTRAINT "GithubActivity_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubActivity" ADD CONSTRAINT "GithubActivity_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubRepoSnapshot" ADD CONSTRAINT "GithubRepoSnapshot_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubRepoSnapshot" ADD CONSTRAINT "GithubRepoSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUnlock" ADD CONSTRAINT "TokenUnlock_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUnlock" ADD CONSTRAINT "TokenUnlock_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenomicsSnapshot" ADD CONSTRAINT "TokenomicsSnapshot_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenomicsSnapshot" ADD CONSTRAINT "TokenomicsSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertTrigger" ADD CONSTRAINT "AlertTrigger_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertTrigger" ADD CONSTRAINT "AlertTrigger_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "AlertTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_coinId_fkey" FOREIGN KEY ("coinId") REFERENCES "Coin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
