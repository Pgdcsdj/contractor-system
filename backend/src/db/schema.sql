-- ============================================================
-- TNB-Training 数据库建表 SQL
-- 数据库：MySQL 8.0
-- 字符集：utf8mb4
-- ============================================================

CREATE DATABASE IF NOT EXISTS tnb_training DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE tnb_training;

-- ─── 1. 人员表 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_user (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name        VARCHAR(50)  NOT NULL                  COMMENT '姓名',
  id_card     VARCHAR(18)  NOT NULL                  COMMENT '身份证号（唯一）',
  qr_token    VARCHAR(64)  NOT NULL DEFAULT ''       COMMENT '入场证二维码Token（SHA-256截断）',
  unit              VARCHAR(100) NOT NULL DEFAULT ''       COMMENT '承包商单位名称',
  supervising_unit  VARCHAR(100) NOT NULL DEFAULT ''       COMMENT '所属主管单位（甲方）',
  phone             VARCHAR(20)           DEFAULT NULL     COMMENT '手机号（可选）',
  status      TINYINT      NOT NULL DEFAULT 1        COMMENT '1=正常 0=禁用',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP             COMMENT '创建时间',
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  UNIQUE KEY  uk_id_card   (id_card),
  KEY         idx_qr_token (qr_token),
  KEY         idx_unit     (unit),
  KEY         idx_supervising_unit (supervising_unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='承包商人员表';

-- ─── 2. 通报素材表 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_material (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  title        VARCHAR(200) NOT NULL                   COMMENT '通报标题',
  file_url     VARCHAR(500) NOT NULL DEFAULT ''        COMMENT '腾讯云COS文件URL',
  file_type    VARCHAR(20)  NOT NULL DEFAULT ''        COMMENT '文件类型: pdf/docx/jpg/png',
  pass_score   TINYINT UNSIGNED NOT NULL DEFAULT 60   COMMENT '及格分数',
  time_limit   SMALLINT UNSIGNED NOT NULL DEFAULT 30  COMMENT '答题时限(分钟)',
  file_size    INT UNSIGNED NOT NULL DEFAULT 0         COMMENT '文件大小(字节)',
  category_id  INT UNSIGNED DEFAULT NULL               COMMENT '分类ID（关联 t_material_category）',
  content_text MEDIUMTEXT            DEFAULT NULL      COMMENT '提取后的文字内容',
  status       TINYINT      NOT NULL DEFAULT 0         COMMENT '0=待出题 1=出题中 2=待审核 3=已发布 4=已下线',
  ai_status    TINYINT      NOT NULL DEFAULT 0         COMMENT '0=未触发 1=处理中 2=成功 3=失败',
  question_cnt TINYINT      NOT NULL DEFAULT 0         COMMENT '已生成题目数量',
  created_by   INT UNSIGNED NOT NULL DEFAULT 0         COMMENT '上传管理员ID',
  target_type  VARCHAR(20)  NOT NULL DEFAULT 'all'     COMMENT '目标类型: all=全员 unit=指定承包商 specific=指定人员',
  target_value JSON                  DEFAULT NULL      COMMENT '目标值: 承包商名称数组或用户ID数组',
  mode         VARCHAR(20)  NOT NULL DEFAULT 'exam'    COMMENT '默认答题模式: study=学习 practice=练习 exam=考试',
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  KEY idx_status (status),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通报素材表';

-- ─── 3. 题目表 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_question (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  material_id INT UNSIGNED NOT NULL                   COMMENT '关联素材ID',
  type        VARCHAR(20)  NOT NULL DEFAULT 'single'  COMMENT '题型: single/multiple/judgment/essay',
  question    TEXT         NOT NULL                   COMMENT '题目内容',
  image_url   VARCHAR(1024)        DEFAULT NULL      COMMENT '题目配图URL（AI图片出题）',
  options     JSON                  DEFAULT NULL      COMMENT '选项: {"A":"...","B":"...","C":"...","D":"..."}',
  answer      VARCHAR(50)  NOT NULL DEFAULT ''        COMMENT '正确答案: A / AB / 正确 / 开放答案',
  analysis    TEXT                  DEFAULT NULL      COMMENT '解析说明',
  score       TINYINT      NOT NULL DEFAULT 5         COMMENT '分值',
  sort_order  TINYINT      NOT NULL DEFAULT 0         COMMENT '排序',
  status      TINYINT      NOT NULL DEFAULT 1         COMMENT '1=启用 0=禁用',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  KEY idx_material_id (material_id),
  KEY idx_status      (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='题目表';

-- ─── 3.5 素材图片表 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_material_image (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  material_id  INT UNSIGNED NOT NULL                   COMMENT '关联素材ID',
  url          VARCHAR(500) NOT NULL                   COMMENT 'COS图片URL',
  sort_order   TINYINT      NOT NULL DEFAULT 0         COMMENT '排序',
  description  VARCHAR(200)          DEFAULT NULL      COMMENT '图片描述',
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  KEY idx_material_id (material_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='素材图片表';

-- ─── 4. 答题记录表 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_record (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  user_id      INT UNSIGNED NOT NULL                   COMMENT '答题人ID',
  material_id  INT UNSIGNED NOT NULL                   COMMENT '关联素材ID',
  answers      JSON         NOT NULL                   COMMENT '用户答案快照: [{questionId,answer,isCorrect,score}]',
  score        SMALLINT     NOT NULL DEFAULT 0         COMMENT '实际得分',
  max_score    SMALLINT     NOT NULL DEFAULT 0         COMMENT '满分分值',
  duration_sec SMALLINT     NOT NULL DEFAULT 0         COMMENT '答题耗时(秒)',
  submitted_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '提交时间',
  is_offline   TINYINT      NOT NULL DEFAULT 0         COMMENT '是否离线提交: 0=在线 1=离线延迟上传',
  hash         VARCHAR(64)  NOT NULL DEFAULT ''        COMMENT 'SHA-256防篡改签名',
  KEY idx_user_id     (user_id),
  KEY idx_material_id (material_id),
  KEY idx_submitted_at (submitted_at),
  UNIQUE KEY uk_user_material (user_id, material_id) COMMENT '同一用户同一题库只能作答一次'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='答题记录表';

-- ─── 5. 管理员表 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_admin (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  username    VARCHAR(50)  NOT NULL                   COMMENT '登录账号',
  password    VARCHAR(100) NOT NULL                   COMMENT 'bcrypt hash密码',
  role        VARCHAR(20)  NOT NULL DEFAULT 'admin'   COMMENT '角色: admin/superadmin',
  status      TINYINT      NOT NULL DEFAULT 1         COMMENT '1=正常 0=禁用',
  last_login  TIMESTAMP             DEFAULT NULL      COMMENT '最后登录时间',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员表';

-- ─── 6. Excel导入日志表 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_import_log (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  filename     VARCHAR(200) NOT NULL                   COMMENT '导入文件名',
  total_rows   SMALLINT     NOT NULL DEFAULT 0         COMMENT '总行数',
  success_rows SMALLINT     NOT NULL DEFAULT 0         COMMENT '成功行数',
  fail_rows    SMALLINT     NOT NULL DEFAULT 0         COMMENT '失败行数',
  fail_detail  JSON                  DEFAULT NULL      COMMENT '失败明细: [{row, error}]',
  imported_by  INT UNSIGNED NOT NULL DEFAULT 0         COMMENT '操作管理员ID',
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Excel人员导入日志';

-- ─── 7. 题库分类表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t_material_category (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name        VARCHAR(50)  NOT NULL                   COMMENT '分类名称',
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '排序',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY  uk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='题库分类标签表';

-- 插入默认分类
INSERT IGNORE INTO t_material_category (name, sort_order) VALUES ('违章通报', 0), ('三新培训', 1), ('常规培训', 2), ('专项培训', 3);

-- ─── 默认管理员（密码: admin123，需上线后立即修改）────────────────────────────────
INSERT IGNORE INTO t_admin (username, password, role)
VALUES ('admin', '$2b$10$bOfb0n4GEjfRFYAwfiEShOoE7FZ/aXTTUgohiiyOsyZP1rdvJNXvq', 'superadmin');
-- 上面的hash对应密码 admin123，请在初始化后立即通过管理员页面修改

-- ─── 8. 隐患主表（闭环）────────────────────────────────────────────────────────────
-- 说明：原 schema.sql 未包含本表，以下定义依据线上库 SHOW CREATE TABLE t_hazard 还原，
--       并新增 remark 备注列（非必填），以保证重新初始化时表结构与线上一致。
CREATE TABLE IF NOT EXISTS t_hazard (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `hazard_code` varchar(30) DEFAULT '' COMMENT '隐患编号（如 YH-2026-0001）',
  `contractor_unit_id` int unsigned DEFAULT NULL COMMENT '关联 t_contractor_unit（五定表"直属单位"）',
  `unit_name` varchar(100) DEFAULT '' COMMENT '冗余承包商单位名（便于统计免 JOIN）',
  `location` varchar(200) DEFAULT '' COMMENT '场所站点 / 位置',
  `category` varchar(100) DEFAULT '' COMMENT '隐患分类（指南目录）',
  `description` text COMMENT '存在问题 / 描述',
  `hazard_level` varchar(20) DEFAULT '一般' COMMENT '隐患等级（重大/较大/一般/低）',
  `is_reject_item` tinyint DEFAULT '0' COMMENT '是否否决项 0/1（问题隐患清单）',
  `deduct_score` varchar(20) DEFAULT '' COMMENT '指南扣分项 / 扣分',
  `rectify_measures` text COMMENT '整改措施（五定表）',
  `responsible_person` varchar(50) DEFAULT '' COMMENT '整改责任人（姓名）',
  `plan_finish_time` datetime DEFAULT NULL COMMENT '计划完成时间（五定表）',
  `rectify_status` varchar(20) DEFAULT '未整改' COMMENT '整改情况（未整改/整改中/已完成）',
  `status` varchar(20) DEFAULT 'reported' COMMENT '状态机：reported→assigned→rectifying→verifying→closed',
  `reported_by` int unsigned DEFAULT NULL COMMENT '上报人 user_id',
  `reported_by_name` varchar(50) DEFAULT '' COMMENT '上报人姓名',
  `report_time` datetime DEFAULT NULL COMMENT '上报时间',
  `photo_url` varchar(500) DEFAULT '' COMMENT '上报照片 COS URL',
  `rectify_photo_url` varchar(500) DEFAULT '' COMMENT '整改后照片 COS URL',
  `assigned_to` int unsigned DEFAULT NULL COMMENT '分派处理人 user_id（安全环保室）',
  `assigned_at` datetime DEFAULT NULL COMMENT '分派时间',
  `verified_by` int unsigned DEFAULT NULL COMMENT '验收人 user_id',
  `verified_at` datetime DEFAULT NULL COMMENT '验收时间',
  `recorder_id` int unsigned DEFAULT NULL COMMENT '录入人 admin.id',
  `recorder_name` varchar(50) DEFAULT '' COMMENT '录入人姓名',
  `recorder_unit_id` int unsigned DEFAULT NULL COMMENT '录入人归属单位 id',
  `recorder_unit_name` varchar(100) DEFAULT '' COMMENT '录入人归属单位名',
  `deleted_at` timestamp NULL DEFAULT NULL COMMENT '软删除时间',
  `verify_result` varchar(20) DEFAULT '' COMMENT '验收结果（通过/退回）',
  `verify_comment` text COMMENT '验收意见',
  `remark` text DEFAULT NULL COMMENT '备注',
  `closed_at` datetime DEFAULT NULL COMMENT '闭环时间',
  `is_overdue` tinyint DEFAULT '0' COMMENT '是否超期（定时任务更新）',
  `overdue_notified` tinyint DEFAULT '0' COMMENT '超期通知是否已发',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `rectify_unit` varchar(100) NOT NULL DEFAULT '' COMMENT '整改单位',
  `business_dept_head` varchar(50) NOT NULL DEFAULT '' COMMENT '业务部门负责人',
  `last_overdue_notify_at` datetime DEFAULT NULL COMMENT '最近一次自动超期通知时间（每日幂等：同自然日不重复发）',
  `business_dept` varchar(100) NOT NULL DEFAULT '' COMMENT '通南巴业务归口',
  `hazard_investigation_item` varchar(200) DEFAULT NULL COMMENT '隐患排查项目',
  PRIMARY KEY (`id`),
  KEY `idx_contractor` (`contractor_unit_id`),
  KEY `idx_status` (`status`),
  KEY `idx_level` (`hazard_level`),
  KEY `idx_plan_finish` (`plan_finish_time`),
  KEY `idx_overdue` (`is_overdue`),
  KEY `idx_category` (`category`),
  KEY `idx_recorder` (`recorder_id`),
  KEY `idx_deleted_at` (`deleted_at`),
  KEY `idx_last_overdue` (`last_overdue_notify_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='隐患主表（闭环）';

-- ─── 完成提示 ───────────────────────────────────────────────────────────────────
SELECT '✅ TNB-Training 数据库表结构初始化完成' AS result;
