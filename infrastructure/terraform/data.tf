resource "aws_security_group" "rds" {
  name_prefix = "${local.cluster_name}-rds-"
  description = "Allows PostgreSQL access from pods running in the EKS cluster's VPC."
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from the cluster's pod security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_db_instance" "core_server" {
  identifier     = "${local.cluster_name}-core-server"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "ruguin"
  username = var.database_username
  password = var.database_password
  port     = 5432

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az = false

  backup_retention_period = 1
  skip_final_snapshot     = true

  tags = local.tags
}

resource "aws_security_group" "elasticache" {
  name_prefix = "${local.cluster_name}-elasticache-"
  description = "Allows Valkey access from pods running in the EKS cluster's VPC."
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Valkey from the cluster's pod security group"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_elasticache_replication_group" "core_server" {
  replication_group_id = "${local.cluster_name}-core-server"
  description          = "Valkey cache for core-server"
  engine               = "valkey"
  engine_version       = "8.0"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  port                 = 6379

  subnet_group_name  = module.vpc.elasticache_subnet_group_name
  security_group_ids = [aws_security_group.elasticache.id]

  automatic_failover_enabled = false

  tags = local.tags
}
