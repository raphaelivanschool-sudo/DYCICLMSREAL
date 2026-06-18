-- CreateTable
CREATE TABLE `AgentPresenceLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agentId` INTEGER NULL,
    `agentKey` VARCHAR(191) NOT NULL,
    `hostname` VARCHAR(191) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `mac` VARCHAR(191) NULL,
    `event` ENUM('ONLINE', 'OFFLINE') NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentPresenceLog_agentKey_at_idx`(`agentKey`, `at`),
    INDEX `AgentPresenceLog_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ControlActionLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actorId` INTEGER NULL,
    `actorRole` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetComputerId` VARCHAR(191) NULL,
    `targetHostname` VARCHAR(191) NULL,
    `targetIp` VARCHAR(191) NULL,
    `result` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ControlActionLog_actorId_idx`(`actorId`),
    INDEX `ControlActionLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentPresenceLog` ADD CONSTRAINT `AgentPresenceLog_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ControlActionLog` ADD CONSTRAINT `ControlActionLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
