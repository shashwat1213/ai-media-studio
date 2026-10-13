# Network layout (2 Availability Zones, no NAT Gateway):
#
#   public subnets   ECS tasks (with a public IP so they can pull from ECR and call OpenRouter;
#                    the security group still blocks ALL inbound except from the load balancer)
#   private subnets  internal ALB + RDS. No route to the internet at all.
#
# Why no NAT Gateway? It costs ~$33/month per AZ before any traffic, more than everything else
# here combined. Public IPs on tasks ($3.65/month each) + strict security groups give the same
# "nothing can connect in" property for a fraction of the price. See specs/06_aws_learnings.md.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  cidr = "10.20.0.0/16"
}

resource "aws_vpc" "main" {
  cidr_block           = local.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # needed for Cloud Map private DNS (redis.<ns>) and RDS endpoints
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(local.cidr, 8, count.index) # 10.20.0.0/24, 10.20.1.0/24
  map_public_ip_on_launch = false                                  # tasks request one explicitly
  tags                    = { Name = "${var.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(local.cidr, 8, count.index + 10) # 10.20.10.0/24, 10.20.11.0/24
  tags              = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private subnets keep the VPC's main route table: local traffic only, no internet route.

# Free S3 gateway endpoint: S3 traffic from tasks stays on the AWS network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.name}-s3" }
}

# Lock down the VPC's default security group (anything accidentally launched without an
# explicit group gets no access at all). Free; checkov CKV2_AWS_12.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}
