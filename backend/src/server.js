/**
 * TNB-Training Express 服务入口
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const express   = require('express')
const path      = require('path')
const fs        = require('fs')
const https     = require('https')
const os        = require('os')
const cors      = require('cors')
const rateLimit = require('express-rate-limit')
const cron      = require('node-cron')

// ─── 路由 ────────────────────────────────────────────────────────────────────
const questionRoutes    = require('./routes/question')
const authRoutes        = require('./routes/auth')
const adminRoutes       = require('./routes/admin')
const quizRoutes        = require('./routes/quiz')
const recordRoutes      = require('./routes/record')
const materialRoutes    = require('./routes/material')
const categoryRoutes    = require('./routes/category')
const quizImportRoutes  = require('./routes/quizImport')
const notifyRoutes      = require('./routes/notify')
const contractorUnitRoutes = require('./routes/contractorUnit')
const hazardRoutes       = require('./routes/hazard')
const hazardDictRoutes   = require('./routes/hazardDict')
const hazardLoopRoutes   = require('./routes/hazardLoop')
const rectifyUnitBizRoutes = require('./routes/rectifyUnitBiz')
const safetyAuthRoutes     = require('./routes/safetyAuth')
const accountRoutes        = require('./routes/accountManage')
const dataManageRoutes     = require('./routes/dataManage')
const { startSchedulers } = require('./services/hazardScheduler')
const backupService       = require('./services/backupService')
const dingtalkRoutes       = require('./routes/dingtalk')        // 钉钉 OAuth 桥接 → Memos 个人工作日志
const contractorDocRoutes   = require('./routes/contractorDoc')   // 承包商开工资料电子化上报（需求 C）
const qualityRoutes         = require('./routes/quality')         // 出题质量量化校验与追踪

// ─── 系统版本常量（与前端 src/version.js 保持一致）─────────────────────
const { APP_VERSION, BUILD_DATE } = require('./version')

const app  = express()
const PORT = process.env.PORT || 3000

// ─── 启动时自动迁移（检查并添加缺失字段/表）──────────────────────────────
async function autoMigrate() {
  const { pool } = require('./db/db')

  // 通用：列存在则跳过
  async function ensureColumn(table, column) {
    const [cols] = await pool.execute(`SHOW COLUMNS FROM ${table} LIKE "${column}"`)
    return cols.length > 0
  }

  // 通用：建表（幂等）
  async function ensureTable(sql) {
    await pool.execute(sql)
  }

  try {
    // 1. t_user.supervising_unit（既有）
    if (!(await ensureColumn('t_user', 'supervising_unit'))) {
      console.log('[migrate] 正在添加 supervising_unit 字段...')
      await pool.execute(
        "ALTER TABLE t_user ADD COLUMN supervising_unit VARCHAR(100) NOT NULL DEFAULT '' COMMENT '所属主管单位（甲方）' AFTER unit"
      )
      await pool.execute('ALTER TABLE t_user ADD INDEX idx_supervising_unit (supervising_unit)')
      console.log('[migrate] ✅ supervising_unit 字段添加完成')
    }

    // 2. t_system_config（修复 schema.sql 缺口：settings 接口引用但未建表）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_system_config (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        config_key   VARCHAR(50)  NOT NULL,
        config_value VARCHAR(2000) DEFAULT NULL,
        remark       VARCHAR(200) DEFAULT NULL,
        updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY   uk_config_key (config_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统配置表（KV）'
    `)
    // 种子配置（隐患闭环相关默认值）
    await pool.execute(`
      INSERT IGNORE INTO t_system_config (config_key, config_value, remark) VALUES
        ('server_public_url',       '',  '系统对外访问地址（用于生成二维码/分享链接）'),
        ('hazard_overdue_days',     '7', '隐患整改超期阈值（天）'),
        ('hazard_grace_days',       '1', '超期前提醒宽限（天）'),
        ('report_require_training', '0', '上报隐患前是否强制完成上岗培训 0/1'),
        ('dingtalk_notify_enabled', '0', '钉钉群机器人通知开关 0/1；与 .env DINGTALK_ROBOT_ENABLED 并存，DB 优先')
    `)

    // 3. 承包商单位维度表（五定表"直属单位"实体化）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_contractor_unit (
        id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        unit_name           VARCHAR(100) NOT NULL,
        supervising_unit    VARCHAR(100) NOT NULL DEFAULT '',
        contact_name        VARCHAR(50)  DEFAULT '',
        contact_phone       VARCHAR(20)  DEFAULT '',
        safety_officer_name VARCHAR(50)  DEFAULT '',
        safety_officer_phone VARCHAR(20) DEFAULT '',
        is_active           TINYINT      NOT NULL DEFAULT 1,
        created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_unit_name (unit_name),
        KEY       idx_supervising (supervising_unit)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='承包商单位表'
    `)

    // 3.5 t_contractor_unit 甲方联系人三列（隐患上报/分派/验收 群@ 路由用）
    //     与 003 / 004 迁移一致：SHOW COLUMNS 守卫 + ALTER，幂等，重启自动生效。
    for (const col of [
      { name: 'party_a_division',      def: "VARCHAR(100) NOT NULL DEFAULT '' COMMENT '甲方主管业务口（群@路由用）'" },
      { name: 'party_a_contact_name',  def: "VARCHAR(200) NOT NULL DEFAULT '' COMMENT '甲方联系人姓名（可多人，/分隔）'" },
      { name: 'party_a_contact_phone', def: "VARCHAR(200) NOT NULL DEFAULT '' COMMENT '甲方联系人手机号（与name同序，/分隔；未解析留空）'" },
    ]) {
      if (!(await ensureColumn('t_contractor_unit', col.name))) {
        console.log(`[migrate] 正在添加 t_contractor_unit.${col.name} 字段...`)
        await pool.execute(`ALTER TABLE t_contractor_unit ADD COLUMN ${col.name} ${col.def}`)
        console.log(`[migrate] ✅ t_contractor_unit.${col.name} 字段添加完成`)
      }
    }

    // 3.6 兼容多反馈人手机号：加宽电话列（原 VARCHAR(20) 装不下 "15181847210 / 15883734601" 等双手机）
    //     仅当当前为 VARCHAR(20) 时才 MODIFY，幂等；改后类型为 VARCHAR(200)，后续启动自动跳过。
    for (const col of ['safety_officer_phone', 'contact_phone']) {
      const [cols] = await pool.execute(
        `SELECT COLUMN_TYPE FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 't_contractor_unit' AND column_name = ?`,
        [col]
      )
      if (cols.length && /varchar\(20\)/i.test(cols[0].COLUMN_TYPE)) {
        console.log(`[migrate] 正在加宽 t_contractor_unit.${col} 字段...`)
        await pool.execute(
          `ALTER TABLE t_contractor_unit MODIFY COLUMN ${col} VARCHAR(200) DEFAULT '' COMMENT '联系电话/安全员手机号（支持多人，/分隔）'`
        )
        console.log(`[migrate] ✅ t_contractor_unit.${col} 加宽完成`)
      }
    }

    // 4. 隐患主表（闭环状态机载体）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_hazard (
        id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        hazard_code          VARCHAR(30)  DEFAULT '',
        contractor_unit_id   INT UNSIGNED DEFAULT NULL,
        unit_name            VARCHAR(100) DEFAULT '',
        location             VARCHAR(200) DEFAULT '',
        category             VARCHAR(100) DEFAULT '',
        description          TEXT,
        hazard_level         VARCHAR(20)  DEFAULT '一般',
        is_reject_item       TINYINT      DEFAULT 0,
        deduct_score         VARCHAR(20)  DEFAULT '',
        rectify_measures     TEXT,
        responsible_person   VARCHAR(50)  DEFAULT '',
        responsible_phone    VARCHAR(20)  DEFAULT '',
        plan_finish_time     DATETIME     DEFAULT NULL,
        rectify_status       VARCHAR(20)  DEFAULT '未整改',
        status               VARCHAR(20)  DEFAULT 'reported',
        reported_by          INT UNSIGNED DEFAULT NULL,
        reported_by_name     VARCHAR(50)  DEFAULT '',
        report_time          DATETIME     DEFAULT NULL,
        photo_url            VARCHAR(500) DEFAULT '',
        rectify_photo_url    VARCHAR(500) DEFAULT '',
        assigned_to          INT UNSIGNED DEFAULT NULL,
        assigned_at          DATETIME     DEFAULT NULL,
        verified_by          INT UNSIGNED DEFAULT NULL,
        verified_at          DATETIME     DEFAULT NULL,
        verify_result        VARCHAR(20)  DEFAULT '',
        verify_comment       TEXT,
        closed_at            DATETIME     DEFAULT NULL,
        is_overdue           TINYINT      DEFAULT 0,
        overdue_notified     TINYINT      DEFAULT 0,
        created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_contractor (contractor_unit_id),
        KEY idx_status      (status),
        KEY idx_level       (hazard_level),
        KEY idx_plan_finish (plan_finish_time),
        KEY idx_overdue     (is_overdue),
        KEY idx_category    (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='隐患主表（闭环）'
    `)

    // 4.5 t_hazard.last_overdue_notify_at（Sprint 3 / 超期扫描每日幂等护栏）
    if (!(await ensureColumn('t_hazard', 'last_overdue_notify_at'))) {
      console.log('[migrate] 正在添加 last_overdue_notify_at 字段...')
      await pool.execute(
        "ALTER TABLE t_hazard ADD COLUMN last_overdue_notify_at DATETIME DEFAULT NULL COMMENT '最近一次自动超期通知时间（每日幂等：同自然日不重复发）'"
      )
      await pool.execute('ALTER TABLE t_hazard ADD KEY idx_last_overdue (last_overdue_notify_at)')
      console.log('[migrate] ✅ last_overdue_notify_at 字段添加完成')
    }

    // 4.6 t_hazard.business_dept（通南巴业务归口，体系审核专项导入新增字段）
    if (!(await ensureColumn('t_hazard', 'business_dept'))) {
      console.log('[migrate] 正在添加 business_dept 字段...')
      await pool.execute(
        "ALTER TABLE t_hazard ADD COLUMN business_dept VARCHAR(100) NOT NULL DEFAULT '' COMMENT '通南巴业务归口'"
      )
      console.log('[migrate] ✅ business_dept 字段添加完成')
    }

    // 4.7 t_hazard.rectify_unit（整改单位，隐患设置可独立维护）
    if (!(await ensureColumn('t_hazard', 'rectify_unit'))) {
      console.log('[migrate] 正在添加 rectify_unit 字段...')
      await pool.execute(
        "ALTER TABLE t_hazard ADD COLUMN rectify_unit VARCHAR(100) NOT NULL DEFAULT '' COMMENT '整改单位'"
      )
      console.log('[migrate] ✅ rectify_unit 字段添加完成')
    }

    // 4.8 t_hazard.business_dept_head（业务部门负责人）
    if (!(await ensureColumn('t_hazard', 'business_dept_head'))) {
      console.log('[migrate] 正在添加 business_dept_head 字段...')
      await pool.execute(
        "ALTER TABLE t_hazard ADD COLUMN business_dept_head VARCHAR(50) NOT NULL DEFAULT '' COMMENT '业务部门负责人'"
      )
      console.log('[migrate] ✅ business_dept_head 字段添加完成')
    }

    // 4.9 t_hazard.hazard_investigation_item（隐患排查项目，自由文本，可空）
    //     与 003_hazard_schema.sql §8 同源；ensureColumn 仅判存在，ALTER 内联。
    if (!(await ensureColumn('t_hazard', 'hazard_investigation_item'))) {
      console.log('[migrate] 正在添加 hazard_investigation_item 字段...')
      await pool.execute(
        "ALTER TABLE t_hazard ADD COLUMN hazard_investigation_item VARCHAR(200) NULL COMMENT '隐患排查项目'"
      )
      console.log('[migrate] ✅ hazard_investigation_item 字段添加完成')
    }

    // 4.9 t_admin 扩展列（安全员账号：姓名 / 电话 / 归属单位），与 004 迁移同源
    for (const col of [
      { name: 'real_name', def: "VARCHAR(50) DEFAULT '' COMMENT '姓名（安全员姓名；管理员也可填）'" },
      { name: 'phone',     def: "VARCHAR(20) DEFAULT '' COMMENT '电话（安全员登录密码=bcrypt(phone)）'" },
      { name: 'unit_id',   def: "INT UNSIGNED DEFAULT NULL COMMENT '归属承包商单位(→t_contractor_unit.id)'" },
    ]) {
      if (!(await ensureColumn('t_admin', col.name))) {
        console.log(`[migrate] 正在添加 t_admin.${col.name} 字段...`)
        let sql = `ALTER TABLE t_admin ADD COLUMN ${col.name} ${col.def}`
        if (col.name === 'unit_id') sql += ', ADD KEY idx_unit_id (unit_id)'
        else sql += ' AFTER password'
        await pool.execute(sql)
        console.log(`[migrate] ✅ t_admin.${col.name} 字段添加完成`)
      }
    }

    // 4.10 t_hazard 扩展列（录入人隔离 + 软删除），与 004 迁移同源
    for (const col of [
      { name: 'recorder_id',        def: "INT UNSIGNED DEFAULT NULL COMMENT '录入人 admin.id'",                       idx: 'idx_recorder' },
      { name: 'recorder_name',      def: "VARCHAR(50) DEFAULT '' COMMENT '录入人姓名'",                              idx: null },
      { name: 'recorder_unit_id',   def: "INT UNSIGNED DEFAULT NULL COMMENT '录入人归属单位 id'",                    idx: null },
      { name: 'recorder_unit_name', def: "VARCHAR(100) DEFAULT '' COMMENT '录入人归属单位名'",                       idx: null },
      { name: 'deleted_at',         def: "TIMESTAMP NULL DEFAULT NULL COMMENT '软删除时间'",                        idx: 'idx_deleted_at' },
    ]) {
      if (!(await ensureColumn('t_hazard', col.name))) {
        console.log(`[migrate] 正在添加 t_hazard.${col.name} 字段...`)
        let sql = `ALTER TABLE t_hazard ADD COLUMN ${col.name} ${col.def}`
        if (col.idx) sql += `, ADD KEY ${col.idx} (${col.name})`
        await pool.execute(sql)
        console.log(`[migrate] ✅ t_hazard.${col.name} 字段添加完成`)
      }
    }

    // 3.7 承包商单位种子数据（体系审核用：通南巴项目部）
    await pool.execute(
      "INSERT IGNORE INTO t_contractor_unit (unit_name) VALUES ('通南巴项目部')"
    )

    // 5. 隐患照片一对多表
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_hazard_photo (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        hazard_id  INT UNSIGNED NOT NULL,
        photo_url  VARCHAR(500) NOT NULL,
        photo_type VARCHAR(20)  DEFAULT 'report',
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_hazard_id (hazard_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='隐患照片表'
    `)

    // 5.5 隐患分类/等级字典表（Sprint 2 / P1-1）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_hazard_dict (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        type          ENUM('level') NOT NULL COMMENT '字典类型',
        code          VARCHAR(50)  NOT NULL                   COMMENT '编码（如 A / 重大）',
        name          VARCHAR(100) NOT NULL                   COMMENT '名称',
        parent_code   VARCHAR(50)  DEFAULT ''                 COMMENT '上级分类编码',
        default_level VARCHAR(20)  DEFAULT ''                 COMMENT '默认等级（category 用）',
        sort_order    INT          DEFAULT 0                  COMMENT '排序',
        enabled       TINYINT      DEFAULT 1                  COMMENT '是否启用',
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_type_code (type, code),
        KEY idx_type  (type),
        KEY idx_parent (parent_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='隐患分类/等级字典表'
    `)

    // 5.55 整改单位 → 业务口 关联表（栏目合并：整改单位 / 业务部门 并入同一关联维护区）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_rectify_unit_biz (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        rectify_unit  VARCHAR(100) NOT NULL                  COMMENT '整改单位',
        business_dept VARCHAR(100) NOT NULL DEFAULT ''       COMMENT '归属业务口/业务部门',
        sort_order    INT          NOT NULL DEFAULT 0,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_rectify (rectify_unit),
        KEY idx_biz (business_dept)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='整改单位与业务口关联'
    `)

    // 5.56 责任单位·业务口关联表：负责人信息（用于后续发钉钉/短信通知给负责人）
    //     因表已存在，CREATE TABLE IF NOT EXISTS 不会改结构，必须用 ensureColumn 加列。
    if (!(await ensureColumn('t_rectify_unit_biz', 'head_name'))) {
      console.log('[migrate] 正在添加 t_rectify_unit_biz.head_name 字段...')
      await pool.execute(
        "ALTER TABLE t_rectify_unit_biz ADD COLUMN head_name VARCHAR(50) NULL COMMENT '负责人姓名'"
      )
      console.log('[migrate] ✅ t_rectify_unit_biz.head_name 字段添加完成')
    }
    if (!(await ensureColumn('t_rectify_unit_biz', 'head_phone'))) {
      console.log('[migrate] 正在添加 t_rectify_unit_biz.head_phone 字段...')
      await pool.execute(
        "ALTER TABLE t_rectify_unit_biz ADD COLUMN head_phone VARCHAR(20) NULL COMMENT '负责人联系电话'"
      )
      console.log('[migrate] ✅ t_rectify_unit_biz.head_phone 字段添加完成')
    }

    // 种子数据（幂等）：等级(level) 仅保留 3 项，code==name，用 upsert 强制写入，
    // 防止被用户删除后回弹；分类(category)/业务口(business_dept)/中心站(center_station) 不再种子（用户全权拥有）。
    await pool.execute(`
      INSERT INTO t_hazard_dict (type, code, name, default_level, sort_order, enabled) VALUES
        ('level','重大隐患','重大隐患','',1,1),
        ('level','较大隐患','较大隐患','',2,1),
        ('level','一般隐患','一般隐患','',3,1)
      ON DUPLICATE KEY UPDATE name=VALUES(name), default_level=VALUES(default_level), enabled=1
    `)

    // 5.6 扩展 t_hazard_dict.type 枚举（支持新字典类型：rectify_unit / business_dept / business_dept_head）
    //     字典后端已放开 type 校验（VALID_TYPES），此处同步扩列 ENUM 保证 seed/insert 不报错。
    //     幂等：仅当当前 ENUM 未含 rectify_unit 时才 ALTER。
    {
      const [enumRows] = await pool.execute(
        `SELECT COLUMN_TYPE FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 't_hazard_dict' AND column_name = 'type'`
      )
      if (enumRows.length && !/rectify_unit/.test(enumRows[0].COLUMN_TYPE)) {
        console.log('[migrate] 正在扩展 t_hazard_dict.type 枚举...')
        await pool.execute(
          "ALTER TABLE t_hazard_dict MODIFY COLUMN type ENUM('level','rectify_unit','business_dept','business_dept_head') NOT NULL COMMENT '字典类型'"
        )
        console.log('[migrate] ✅ t_hazard_dict.type 枚举扩展完成')
      }
    }

    // 5.65 扩展 t_hazard_dict.type 枚举（追加 center_station / well_site / facility / hazard_investigation_item）
    //     与 005_hazard_import_dict.sql 同源；幂等：仅当 ENUM 未含 center_station 时才 ALTER。
    {
      const [enumRows2] = await pool.execute(
        `SELECT COLUMN_TYPE FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 't_hazard_dict' AND column_name = 'type'`
      )
      if (enumRows2.length && !/center_station/.test(enumRows2[0].COLUMN_TYPE)) {
        console.log('[migrate] 正在扩展 t_hazard_dict.type 枚举（导入专项）...')
        await pool.execute(
          "ALTER TABLE t_hazard_dict MODIFY COLUMN type ENUM('level','rectify_unit','business_dept','business_dept_head','center_station','well_site','facility','hazard_investigation_item') NOT NULL COMMENT '字典类型'"
        )
        console.log('[migrate] ✅ t_hazard_dict.type 枚举扩展完成（导入专项）')
      }
    }

    // 5.66 种子：9 个隐患排查项目（与 9 个 sheet 标题逐字一致，保证导出筛选命中）+ 中心站
    const SEED_INVESTIGATION_ITEMS = [
      '主题交流会问题', '钢格栅隐患专项排查', '前期遗留问题', '操作台问题', '井口防护罩安装',
      '分公司上半年安全大检查', '零散井回收安全专项检查', '陆上石油天然气开采安全风险评估自查问题', '马3块安全验收问题',
    ]
    for (let si = 0; si < SEED_INVESTIGATION_ITEMS.length; si++) {
      const name = SEED_INVESTIGATION_ITEMS[si]
      await pool.execute(
        `INSERT INTO t_hazard_dict (type, code, name, sort_order, enabled)
          SELECT 'hazard_investigation_item', ?, ?, ?, 1 FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM t_hazard_dict WHERE type='hazard_investigation_item' AND code=?)`,
        [name, name, si + 1, name]
      )
    }
    // 5.66 中心站不再硬编码种子（改由 T3 「字典导入」接口 / 用户维护）

    // 5.7 种子：整改单位（NOT EXISTS 防重复；business_dept_head 不种子，用户自行维护）。
    // ⚠ 业务部门(business_dept) 5 个硬编码种子已移除：业务口改由用户全权拥有，不再回弹。
    await pool.execute(`
      INSERT INTO t_hazard_dict (type, code, name, sort_order, enabled)
        SELECT 'rectify_unit','通南巴项目部','通南巴项目部',1,1 FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM t_hazard_dict WHERE type='rectify_unit' AND code='通南巴项目部')
    `)

    // 6. t_user 扩展：钉钉 userid + 承包商单位关联
    if (!(await ensureColumn('t_user', 'dingtalk_userid'))) {
      await pool.execute("ALTER TABLE t_user ADD COLUMN dingtalk_userid VARCHAR(64) NOT NULL DEFAULT '' COMMENT '钉钉userid（甲方人员，Tier1待办用）'")
    }
    if (!(await ensureColumn('t_user', 'contractor_unit_id'))) {
      await pool.execute('ALTER TABLE t_user ADD COLUMN contractor_unit_id INT UNSIGNED DEFAULT NULL COMMENT \'关联承包商单位ID（按单位聚合绩效）\'')
    }

    // STEP 7：钉钉通知审计日志表（与 migrations/002_dingtalk_notify_log.sql 同源）
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS dingtalk_notify_log (
        id         INT          NOT NULL AUTO_INCREMENT,
        event      VARCHAR(50)  NOT NULL DEFAULT '',
        channel    VARCHAR(20)  NOT NULL DEFAULT 'group_robot',
        receiver   VARCHAR(100) NOT NULL DEFAULT '',
        content    TEXT,
        status     VARCHAR(10)  NOT NULL DEFAULT 'sent',
        errmsg     VARCHAR(500) DEFAULT NULL,
        created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_event (event),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='钉钉通知审计日志'
    `)
    // 隐患定时任务（超期扫描 + 周报），需在 last_overdue_notify_at 列就绪后启动
    try {
      startSchedulers(pool)
    } catch (e) {
      console.error('[migrate] 定时任务启动失败（不影响迁移）', e.message)
    }

    // STEP 8：承包商开工资料电子化上报（需求 C）
    // 8.1 t_contractor_unit.short_name（文件命名 [承包商简称] 用）
    if (!(await ensureColumn('t_contractor_unit', 'short_name'))) {
      await pool.execute("ALTER TABLE t_contractor_unit ADD COLUMN short_name VARCHAR(60) NOT NULL DEFAULT '' COMMENT '承包商简称（用于资料文件命名）' AFTER unit_name")
    }
    // 8.2 三张表
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_doc_catalog (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category      VARCHAR(50)  NOT NULL COMMENT '体系分类',
        item_name     VARCHAR(150) NOT NULL COMMENT '资料名称/目录',
        freq          VARCHAR(50)  DEFAULT '' COMMENT '更新/报送频次',
        required_type ENUM('gate','dynamic') NOT NULL DEFAULT 'dynamic' COMMENT 'gate=开工门槛(否决项) dynamic=动态维护',
        sort_order    TINYINT UNSIGNED NOT NULL DEFAULT 0,
        is_active     TINYINT      NOT NULL DEFAULT 1,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_category (category),
        KEY idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='承包商开工资料目录项'
    `)
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_doc_package (
        id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        unit_id        INT UNSIGNED NOT NULL,
        unit_name      VARCHAR(100) NOT NULL,
        unit_short     VARCHAR(60)  NOT NULL DEFAULT '',
        project_name   VARCHAR(150) NOT NULL COMMENT '工程/项目名称',
        reporter_name  VARCHAR(50)  DEFAULT '' COMMENT '上报人留痕',
        reporter_phone VARCHAR(20)  DEFAULT '' COMMENT '上报人电话留痕',
        status         TINYINT      NOT NULL DEFAULT 0 COMMENT '0 进行中 1 已提交',
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_unit (unit_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='承包商开工资料-项目包（每项目一张表）'
    `)
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_doc_file (
        id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        package_id     INT UNSIGNED NOT NULL,
        catalog_id     INT UNSIGNED NOT NULL,
        catalog_name   VARCHAR(150) NOT NULL DEFAULT '' COMMENT '资料项名称冗余',
        category       VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '体系分类冗余',
        original_name  VARCHAR(255) DEFAULT '' COMMENT '原文件名',
        sys_name       VARCHAR(255) NOT NULL COMMENT '系统命名 [简称]-[分类]-[日期].ext',
        cos_key        VARCHAR(255) NOT NULL,
        cos_url        VARCHAR(512) DEFAULT '',
        file_ext       VARCHAR(10)  DEFAULT '',
        file_size      INT UNSIGNED DEFAULT 0,
        uploader_name  VARCHAR(50)  DEFAULT '' COMMENT '录入人姓名留痕（本人删改校验）',
        uploader_phone VARCHAR(20)  DEFAULT '' COMMENT '录入人电话留痕',
        uploaded_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_package (package_id),
        KEY idx_catalog (catalog_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='承包商开工资料-附件'
    `)
    // 8.3 种子目录（仅首次空表时写入，幂等）
    const [cc] = await pool.execute('SELECT COUNT(*) AS c FROM t_doc_catalog')
    if (cc[0].c === 0) {
      const seed = [
        ['资质准入', '安全生产许可证', '动态更新', 'dynamic', 1],
        ['资质准入', 'HSE管理体系/安全生产标准化证书', '动态更新', 'dynamic', 2],
        ['资质准入', '近3年HSE业绩证明、失信惩戒名单核查', '投标/准入时', 'gate', 3],
        ['资质准入', '主要负责人、安全管理人员安全资格证', '动态更新', 'dynamic', 4],
        ['资质准入', '特种作业/特种设备作业人员资格证（含井控、H2S等）', '动态更新', 'dynamic', 5],
        ['资质准入', '承包商人员身份信息台账、公安比对证明', '入场前', 'gate', 6],
        ['资质准入', '承包商关键人员培训合格证（中石化认可机构）', '动态更新', 'dynamic', 7],
        ['组织制度', '基层网格化责任清单', '动态更新', 'dynamic', 1],
        ['合同协议', '安全生产管理协议', '签订时', 'gate', 1],
        ['合同协议', '交叉作业安全管理协议（多承包商区域）', '施工前', 'gate', 2],
        ['方案风险', '施工组织设计/施工方案（含HSE技术措施）', '施工前', 'gate', 1],
        ['方案风险', '专项施工方案（高风险作业、检维修等）', '施工前', 'gate', 2],
        ['培训教育', '人员入厂（场）前安全培训和书面告知记录', '入场前', 'gate', 1],
        ['培训教育', '关键管理人员专项安全培训及考核记录', '按需', 'dynamic', 2],
        ['培训教育', '“三级安全教育”及专项培训（井控/H2S等）记录', '动态完善', 'dynamic', 3],
        ['作业许可', '特种设备/压力容器注册登记及检验台账', '注册前后', 'gate', 1],
        ['作业许可', '施工机具、设备入场检查合格证及台账', '入场前', 'gate', 2],
        ['隐患应急', '应急预案/现场处置方案及备案证明', '编制后', 'gate', 1],
        ['检查考核', '项目开工安全许可证（附件6.7）', '开工前', 'gate', 1],
      ]
      for (const [category, item_name, freq, required_type, sort_order] of seed) {
        await pool.execute(
          'INSERT INTO t_doc_catalog (category, item_name, freq, required_type, sort_order) VALUES (?, ?, ?, ?, ?)',
          [category, item_name, freq, required_type, sort_order]
        )
      }
      console.log('[migrate] ✅ 已写入承包商开工资料目录种子（19 项）')
    }
    // 9. t_material.mode（默认答题模式：study/practice/exam）
    //    修复 Bug：创建/导入/发布题库时未持久化 mode，导致前端始终只看到"考试"组。
    //    生产库已有该列，ensureColumn 守卫保证幂等 no-op（绝不报错）。
    if (!(await ensureColumn('t_material', 'mode'))) {
      console.log('[migrate] 正在添加 t_material.mode 字段...')
      await pool.execute(
        "ALTER TABLE t_material ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'exam' COMMENT '默认答题模式: study=学习 practice=练习 exam=考试'"
      )
      console.log('[migrate] ✅ t_material.mode 字段添加完成')
    }

    // 9.5 考试随机抽题配置：各题型抽取数量（0 = 全抽，不限制）
    //     导入题库时在 QuizImportPage 设定；考试模式按此从题库随机抽取，避免大题库全考。
    for (const col of [
      { name: 'exam_single_num',   ddl: "ALTER TABLE t_material ADD COLUMN exam_single_num   INT NOT NULL DEFAULT 0 COMMENT '考试随机抽单选题数，0=全抽'" },
      { name: 'exam_multiple_num', ddl: "ALTER TABLE t_material ADD COLUMN exam_multiple_num INT NOT NULL DEFAULT 0 COMMENT '考试随机抽多选题数，0=全抽'" },
      { name: 'exam_judgment_num', ddl: "ALTER TABLE t_material ADD COLUMN exam_judgment_num INT NOT NULL DEFAULT 0 COMMENT '考试随机抽判断题数，0=全抽'" },
    ]) {
      if (!(await ensureColumn('t_material', col.name))) {
        console.log(`[migrate] 正在添加 t_material.${col.name} 字段...`)
        await pool.execute(col.ddl)
        console.log(`[migrate] ✅ t_material.${col.name} 字段添加完成`)
      }
    }

    // ── 10. 出题质量量化校验与追踪机制 ──────────────────────────────────
    //     10.1 t_question 质量标注列（5 列）
    //     10.2 t_material.source_keypoints（源文档关键点缓存）
    //     10.3 t_quality_config / t_question_revision_log / t_quality_report
    //     全部用 ensureColumn / CREATE TABLE IF NOT EXISTS 守卫，可重复执行。
    const questionQualityCols = [
      {
        name: 'difficulty',
        ddl: "ALTER TABLE t_question ADD COLUMN difficulty TINYINT NOT NULL DEFAULT 3 COMMENT '难度 1-5'",
      },
      {
        name: 'bloom_level',
        ddl: "ALTER TABLE t_question ADD COLUMN bloom_level VARCHAR(10) NOT NULL DEFAULT '理解' COMMENT 'Bloom 认知层级: 识记/理解/应用'",
      },
      {
        name: 'knowledge_points',
        ddl: "ALTER TABLE t_question ADD COLUMN knowledge_points TEXT DEFAULT NULL COMMENT '知识点标签 JSON 数组'",
      },
      {
        name: 'source_keypoints',
        ddl: "ALTER TABLE t_question ADD COLUMN source_keypoints TEXT DEFAULT NULL COMMENT '源文档依据要点 JSON 数组'",
      },
      {
        name: 'quality_round',
        ddl: "ALTER TABLE t_question ADD COLUMN quality_round INT NOT NULL DEFAULT 1 COMMENT '所属出题轮次（每次重新生成 +1）'",
      },
    ]
    for (const col of questionQualityCols) {
      if (!(await ensureColumn('t_question', col.name))) {
        console.log(`[migrate] 正在添加 t_question.${col.name} 字段...`)
        await pool.execute(col.ddl)
        console.log(`[migrate] ✅ t_question.${col.name} 字段添加完成`)
      }
    }

    if (!(await ensureColumn('t_material', 'source_keypoints'))) {
      console.log('[migrate] 正在添加 t_material.source_keypoints 字段...')
      await pool.execute(
        "ALTER TABLE t_material ADD COLUMN source_keypoints MEDIUMTEXT DEFAULT NULL COMMENT '源文档关键点缓存 JSON 数组（覆盖率校验用）'"
      )
      console.log('[migrate] ✅ t_material.source_keypoints 字段添加完成')
    }

    // 质量校验配置表：material_id 为 NULL + is_default=1 表示全局默认配置
    //   列定义与 services/qualityService.js 的 getConfig / saveConfig 严格对齐
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_quality_config (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        material_id   INT UNSIGNED DEFAULT NULL COMMENT '素材ID；NULL 表示全局默认',
        name          VARCHAR(80)  NOT NULL DEFAULT '' COMMENT '配置名称',
        config_json   TEXT         DEFAULT NULL COMMENT '配置内容 JSON',
        is_default    TINYINT      NOT NULL DEFAULT 0 COMMENT '1=全局默认配置',
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_material (material_id),
        KEY idx_is_default (is_default)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出题质量校验配置'
    `)

    // 题目修订留痕表
    //   列定义与 qualityService.logRevision / getRevisionHistory 严格对齐
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_question_revision_log (
        id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        material_id   INT UNSIGNED NOT NULL COMMENT '素材ID',
        round_no      INT          NOT NULL DEFAULT 0 COMMENT '出题轮次',
        operator_id   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '操作人ID',
        operator_name VARCHAR(40)  NOT NULL DEFAULT '' COMMENT '操作人名称',
        op_type       VARCHAR(20)  NOT NULL DEFAULT 'EDIT' COMMENT 'GENERATE/RETRY/EDIT/DELETE/ADD/ENRICH',
        op_content    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '操作摘要',
        reason        TEXT         DEFAULT NULL COMMENT '修订原因',
        before_json   MEDIUMTEXT   DEFAULT NULL COMMENT '变更前快照 JSON',
        after_json    MEDIUMTEXT   DEFAULT NULL COMMENT '变更后快照 JSON',
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_material (material_id),
        KEY idx_material_round (material_id, round_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='题目修订留痕'
    `)

    // 质量报告表（每次校验落一条，取最新一条展示）
    //   列定义与 qualityService.runQualityCheck / getLatestReport 严格对齐
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_quality_report (
        id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        material_id      INT UNSIGNED   NOT NULL COMMENT '素材ID',
        round_no         INT            NOT NULL DEFAULT 0 COMMENT '校验时的轮次',
        report_json      MEDIUMTEXT     DEFAULT NULL COMMENT '完整报告 JSON',
        coverage_pct     DECIMAL(5,2)   NOT NULL DEFAULT 0 COMMENT '源文档覆盖率 %',
        consistency_pass TINYINT        NOT NULL DEFAULT 0 COMMENT '整卷一致性是否通过 0/1',
        quality_score    SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '综合质量分 0-100',
        created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_material (material_id),
        KEY idx_material_created (material_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出题质量报告'
    `)

    // 10.4 错题表：员工在学习/练习/考试中答错的题，用于错题库重点学习
    //     唯一键 (user_id, question_id) 保证每人每题仅一条；答对后移出。
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS t_wrong_question (
        id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id       INT UNSIGNED NOT NULL COMMENT '员工ID',
        material_id   INT UNSIGNED NOT NULL COMMENT '题库ID',
        question_id   INT UNSIGNED NOT NULL COMMENT '题目ID',
        mode          VARCHAR(20)  NOT NULL DEFAULT 'exam' COMMENT '作答模式: study/practice/exam',
        wrong_times   INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '累计答错次数',
        last_wrong_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次答错时间',
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_question (user_id, question_id),
        KEY idx_user (user_id),
        KEY idx_material (material_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工错题记录'
    `)

    // 10.5 错题库「重点标记」列（错题练习优先复习）
    if (!(await ensureColumn('t_wrong_question', 'starred'))) {
      await pool.execute(
        "ALTER TABLE t_wrong_question ADD COLUMN starred TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否重点标记(1=置顶优先复习)'"
      )
    }

    // 种子：全局默认质量配置（仅当不存在时写入）
    const [defaultCfgRows] = await pool.execute(
      'SELECT id FROM t_quality_config WHERE material_id IS NULL AND is_default = 1 LIMIT 1'
    )
    if (!defaultCfgRows.length) {
      const seedCfg = JSON.stringify({
        expectedCount: 10,
        typeDistribution: { single: 0.4, multiple: 0.3, judgment: 0.2, essay: 0.1 },
        difficultyHistogram: { 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.2, 5: 0.1 },
        bloomDistribution: { 识记: 0.3, 理解: 0.5, 应用: 0.2 },
        coverageThreshold: 0.8,
        kpMinCount: 5,
      })
      await pool.execute(
        'INSERT INTO t_quality_config (material_id, name, config_json, is_default) VALUES (NULL, ?, ?, 1)',
        ['全局默认质量配置', seedCfg]
      )
      console.log('[migrate] ✅ 已写入全局默认质量校验配置')
    }
    console.log('[migrate] ✅ 出题质量校验相关表结构已就绪')

    console.log('[migrate] ✅ 隐患闭环相关表结构已就绪')
  } catch (err) {
    console.error('[migrate] 自动迁移失败:', err.message)
  }
}
autoMigrate()

// ─── 中间件 ──────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// 限流：AI接口每IP每分钟30次
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: '请求过于频繁，请稍后再试' },
})

// ─── 路由挂载 ────────────────────────────────────────────────────────────────
app.use('/api/ai',     aiLimiter, questionRoutes)  // AI出题/评分
app.use('/api/auth',   authRoutes)                  // 登录认证
app.use('/api/admin',  adminRoutes)                 // 管理员（人员导入等）
app.use('/api/quiz',   quizRoutes)                  // 员工答题
app.use('/api/record',   recordRoutes)                // 答题记录（管理员）
app.use('/api/material', materialRoutes)              // 素材上传与题库管理
app.use('/api/admin/categories', categoryRoutes)      // 题库分类管理
app.use('/api/admin/quiz-import', quizImportRoutes)   // 题库导入/导出
app.use('/api/notify', notifyRoutes)                  // 钉钉通知（Sprint 1 / Tier 0）
app.use('/api/contractor-units', contractorUnitRoutes)  // 承包商单位 CRUD + 导入（S1-3）
app.use('/api/hazard', hazardRoutes)                    // 隐患照片上传（S1-4）
app.use('/api/hazard-dict', hazardDictRoutes)            // 隐患分类/等级字典（S2 / P1-1）
app.use('/api/hazards', hazardLoopRoutes)                // 隐患闭环状态机（S2 / P0）
app.use('/api/rectify-unit-biz', rectifyUnitBizRoutes)   // 整改单位→业务口关联（S2 / 关联维护）
app.use('/api/safety',  safetyAuthRoutes)                 // 安全员登录（公开，无需鉴权）
app.use('/api/account', accountRoutes)                    // 账号管理（admin/superadmin）
app.use('/api/data',    dataManageRoutes)                 // 数据备份/导出（admin/superadmin）
app.use('/api/dingtalk', dingtalkRoutes)                   // 钉钉 OAuth 桥接 → Memos 个人工作日志（T01/T02）
app.use('/api/contractor-docs', contractorDocRoutes)        // 承包商开工资料电子化上报（需求 C）
app.use('/api/quality', qualityRoutes)                      // 出题质量量化校验与追踪

// ─── 定时备份（每周日 23:00）────────────────────────────────────────────────
// P1：服务进程内 node-cron；失败仅 console.error + 写审计日志（未建），不阻塞主进程。
// 备份后执行保留策略（删除 >30 天文件）。
try {
  cron.schedule('0 23 * * 0', () => {
    backupService.backupNow()
      .then(() => backupService.pruneBackups(30))
      .catch((e) => console.error('[backup]', e && e.message ? e.message : e))
  })
  console.log('[cron] ✅ 定时备份已注册（每周日 23:00）')
} catch (e) {
  console.error('[cron] 定时备份注册失败（不影响主服务）:', e.message)
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: APP_VERSION })
})

// 系统版本（公开，无需鉴权）
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, buildDate: BUILD_DATE })
})

// ─── 域名落地页（根路径指向 landing.html）────────────────────────
const landingHtml = path.resolve(__dirname, '../../frontend/public/landing.html')
app.get('/', (req, res) => {
  res.sendFile(landingHtml, (err) => {
    if (err) {
      console.error('[landing] 首页文件未找到，请确认 frontend/public/landing.html 存在:', err.message)
      // 兜底：返回 404 或自动跳转到 /tnb/
      res.redirect('/tnb/')
    }
  })
})

// ─── 前端静态文件（打包后的 dist） ─────────────────────────────
// 相对 backend 根目录解析：backend/../frontend/dist = <项目根>/frontend/dist
const backendRoot = path.resolve(__dirname, '..')
const frontendDist = path.resolve(
  process.env.FRONTEND_DIST || path.join(backendRoot, '../frontend/dist')
)
// 前端构建 base 为 /tnb/，故同时挂载根与 /tnb 前缀，保证资源与入口均可访问
// 注意：开头的 / 路由已被 landing 页占用，此处只服务静态资源，不覆盖 /
app.use(express.static(frontendDist))
app.use('/tnb', express.static(frontendDist))

// ─── 错误处理 ────────────────────────────────────────────────────────────────
// 全局 async 错误捕获
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件超过 5MB 限制' })
  }
  res.status(500).json({
    error:  '服务器内部错误',
    detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
  })
})

// ── SPA 回退：非 /api 的 GET 请求返回前端入口文件（覆盖 / 与 /tnb/*）──
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return res.status(404).json({ error: '接口不存在' })
  }
  res.sendFile(path.join(frontendDist, 'index.html'))
})

// ─── 启动 ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ TNB-Training 后端服务已启动`)
  console.log(`   端口:     http://localhost:${PORT}`)
  console.log(`   健康检查: http://localhost:${PORT}/health`)
  console.log(`   路由清单:`)
  console.log(`     /api/ai      AI出题与评分`)
  console.log(`     /api/auth    登录认证`)
  console.log(`     /api/admin   管理员操作`)
  console.log(`     /api/quiz    员工答题`)
  console.log(`     /api/record  答题记录`)
})

// ─── HTTPS（自签证书，仅测试用，不引入新依赖，复用同一 express app）──────────
/**
 * 是否启用 HTTPS：
 *   - ENABLE_HTTPS=false  → 强制关闭
 *   - ENABLE_HTTPS=true   → 强制开启（证书缺失会报错跳过）
 *   - 未设置              → 若 backend/certs/{cert.pem,key.pem} 存在则自动启用
 */
function resolveCertPaths() {
  const certPath = path.resolve(backendRoot, process.env.SSL_CERT_PATH || 'certs/cert.pem')
  const keyPath  = path.resolve(backendRoot, process.env.SSL_KEY_PATH  || 'certs/key.pem')
  return { certPath, keyPath }
}

function httpsShouldEnable() {
  const flag = process.env.ENABLE_HTTPS
  if (flag === 'false') return false
  if (flag === 'true') return true
  const { certPath, keyPath } = resolveCertPaths()
  return fs.existsSync(certPath) && fs.existsSync(keyPath)
}

/** 取一个非内环 IPv4 地址，用于提示局域网访问地址（可选） */
function getLanIp() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

if (httpsShouldEnable()) {
  const { certPath, keyPath } = resolveCertPaths()
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10)
  try {
    const httpsOptions = {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    }
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
      const lanIp = getLanIp()
      console.log(`🔐 HTTPS 已启用（自签证书，仅测试用）:`)
      console.log(`   本机访问:   https://localhost:${HTTPS_PORT}`)
      console.log(`   局域网访问: https://${lanIp}:${HTTPS_PORT}`)
      console.log(`   健康检查:   https://localhost:${HTTPS_PORT}/health`)
      console.log(`   ⚠️ 生产环境请替换为 CA 签发证书并完成 ICP 备案`)
    })
  } catch (err) {
    console.warn(`⚠️  HTTPS 启动失败，已跳过（不影响 HTTP 开发流）: ${err.message}`)
  }
} else {
  console.log(
    `ℹ️  HTTPS 未启用（未检测到 ${path.join(backendRoot, 'certs')} 下证书；` +
    `运行 node scripts/gen-selfsigned-cert.mjs 生成后自动启用）`
  )
}

module.exports = app
