#define _DARWIN_C_SOURCE 1
#define __APPLE_API_UNSTABLE 1

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>

#define RENAME_EXCL_VALUE 0x00000004U
#define RENAME_EXCL_CAP_VALUE 0x00080000U

#if RENAME_EXCL != RENAME_EXCL_VALUE
#error "SDK RENAME_EXCL value differs from the reviewed API value"
#endif
#if VOL_CAP_INT_RENAME_EXCL != RENAME_EXCL_CAP_VALUE
#error "SDK VOL_CAP_INT_RENAME_EXCL value differs from the reviewed API value"
#endif

struct identity {
    uint64_t dev;
    uint64_t ino;
};

struct volume_caps {
    uint32_t valid;
    uint32_t capabilities;
};

static int fail(const char *message, int code)
{
    fprintf(stderr, "error=%s errno=%d\n", message, code);
    return 64;
}

static bool parse_u64(const char *text, uint64_t *value)
{
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') return false;
    *value = (uint64_t)parsed;
    return true;
}

static bool parse_identity(const char *dev_text, const char *ino_text, struct identity *identity)
{
    return parse_u64(dev_text, &identity->dev) && parse_u64(ino_text, &identity->ino);
}

static bool matches_identity(const struct stat *st, const struct identity *identity)
{
    return (uint64_t)st->st_dev == identity->dev && (uint64_t)st->st_ino == identity->ino;
}

static int canonical_root(const char *input, char resolved[PATH_MAX], int *root_fd, struct stat *root_stat)
{
    if (input[0] != '/') return fail("root-not-absolute", EINVAL);
    if (realpath(input, resolved) == NULL) return fail("root-realpath", errno);
    if (strcmp(input, resolved) != 0) return fail("root-not-canonical", ELOOP);

    int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0) return fail("root-open-slash", errno);
    char *copy = strdup(resolved + 1);
    if (copy == NULL) { close(current); return fail("root-path-allocation", ENOMEM); }

    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0 || part[0] == '\0') {
            close(current); free(copy);
            return fail("unsafe-root-component", EINVAL);
        }
        int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current); free(copy);
            return fail("root-component-openat", saved);
        }
        close(current);
        current = next;
    }
    free(copy);
    *root_fd = current;
    if (fstat(*root_fd, root_stat) != 0) return fail("root-fstat", errno);
    if (!S_ISDIR(root_stat->st_mode)) return fail("root-not-directory", ENOTDIR);
    return 0;
}

static int query_volume_caps(const char *root_path, struct volume_caps *caps)
{
    struct attrlist attributes;
    memset(&attributes, 0, sizeof(attributes));
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.volattr = ATTR_VOL_CAPABILITIES;

    struct {
        uint32_t length;
        vol_capabilities_attr_t attributes;
    } buffer;
    memset(&buffer, 0, sizeof(buffer));

    if (getattrlist(root_path, &attributes, &buffer, sizeof(buffer), FSOPT_NOFOLLOW) != 0)
        return -1;
    if (buffer.length < sizeof(buffer)) {
        errno = EIO;
        return -1;
    }
    caps->valid = buffer.attributes.valid[VOL_CAPABILITIES_INTERFACES];
    caps->capabilities = buffer.attributes.capabilities[VOL_CAPABILITIES_INTERFACES];
    return 0;
}

static int open_relative_directory(int root_fd, const char *relative, int *result_fd)
{
    if (strcmp(relative, ".") == 0) {
        *result_fd = dup(root_fd);
        if (*result_fd < 0) return fail("dup-root", errno);
        return 0;
    }
    if (relative[0] == '\0' || relative[0] == '/' || relative[strlen(relative) - 1] == '/')
        return fail("parent-path-not-relative", EINVAL);

    char *copy = strdup(relative);
    if (copy == NULL) return fail("parent-path-allocation", ENOMEM);

    int current = dup(root_fd);
    if (current < 0) {
        free(copy);
        return fail("dup-root", errno);
    }

    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0 || part[0] == '\0') {
            close(current);
            free(copy);
            return fail("unsafe-parent-component", EINVAL);
        }
        int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current);
            free(copy);
            return fail("parent-openat", saved);
        }
        close(current);
        current = next;
    }
    free(copy);
    *result_fd = current;
    return 0;
}

static bool valid_basename(const char *name)
{
    return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static const char *errno_name(int code)
{
    switch (code) {
        case EEXIST: return "EEXIST";
        case ENOENT: return "ENOENT";
        case EINVAL: return "EINVAL";
        case ENOTSUP: return "ENOTSUP";
        case EXDEV: return "EXDEV";
        case ELOOP: return "ELOOP";
        default: return "OTHER";
    }
}

static int capabilities_command(const char *root_input)
{
    char root_path[PATH_MAX];
    int root_fd = -1;
    struct stat root_stat;
    int status = canonical_root(root_input, root_path, &root_fd, &root_stat);
    if (status != 0) return status;

    struct volume_caps caps;
    if (query_volume_caps(root_path, &caps) != 0) {
        int saved = errno;
        close(root_fd);
        return fail("getattrlist-volume-capabilities", saved);
    }
    close(root_fd);

    bool valid = (caps.valid & RENAME_EXCL_CAP_VALUE) != 0;
    bool supported = (caps.capabilities & RENAME_EXCL_CAP_VALUE) != 0;
    printf("{\"operation\":\"volume-capabilities\",\"volume_dev\":\"%" PRIu64 "\",\"valid_interfaces_hex\":\"0x%08" PRIx32 "\",\"capabilities_interfaces_hex\":\"0x%08" PRIx32 "\",\"rename_excl_valid\":%s,\"rename_excl_supported\":%s}\n",
           (uint64_t)root_stat.st_dev, caps.valid, caps.capabilities,
           valid ? "true" : "false", supported ? "true" : "false");
    if (!valid || !supported) return fail("volume-does-not-advertise-valid-rename-excl", ENOTSUP);
    return 0;
}

static int place_command(int argc, char **argv)
{
    if (argc != 15 && argc != 16) return fail("place-argument-count", EINVAL);
    bool inject = argc == 16 && strcmp(argv[15], "--race-empty-dir") == 0;
    if (argc == 16 && !inject) return fail("unknown-place-option", EINVAL);

    const char *root_input = argv[2];
    const char *source_parent_relative = argv[3];
    const char *source_name = argv[4];
    const char *target_parent_relative = argv[5];
    const char *target_name = argv[6];
    if (!valid_basename(source_name) || !valid_basename(target_name))
        return fail("basename-must-be-single-component", EINVAL);

    struct identity expected_root, expected_source_parent, expected_target_parent, expected_source;
    if (!parse_identity(argv[7], argv[8], &expected_root) ||
        !parse_identity(argv[9], argv[10], &expected_source_parent) ||
        !parse_identity(argv[11], argv[12], &expected_target_parent) ||
        !parse_identity(argv[13], argv[14], &expected_source))
        return fail("identity-parse", EINVAL);

    char root_path[PATH_MAX];
    int root_fd = -1;
    struct stat root_stat;
    int status = canonical_root(root_input, root_path, &root_fd, &root_stat);
    if (status != 0) return status;
    if (!matches_identity(&root_stat, &expected_root)) {
        close(root_fd);
        return fail("root-identity-mismatch", ESTALE);
    }

    struct volume_caps caps;
    if (query_volume_caps(root_path, &caps) != 0) {
        int saved = errno;
        close(root_fd);
        return fail("getattrlist-volume-capabilities", saved);
    }
    if ((caps.valid & RENAME_EXCL_CAP_VALUE) == 0 ||
        (caps.capabilities & RENAME_EXCL_CAP_VALUE) == 0) {
        close(root_fd);
        return fail("volume-does-not-advertise-valid-rename-excl", ENOTSUP);
    }

    int source_parent_fd = -1;
    int target_parent_fd = -1;
    status = open_relative_directory(root_fd, source_parent_relative, &source_parent_fd);
    if (status != 0) { close(root_fd); return status; }
    status = open_relative_directory(root_fd, target_parent_relative, &target_parent_fd);
    if (status != 0) { close(source_parent_fd); close(root_fd); return status; }

    struct stat source_parent_stat, target_parent_stat;
    if (fstat(source_parent_fd, &source_parent_stat) != 0 ||
        fstat(target_parent_fd, &target_parent_stat) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-fstat", saved);
    }
    if (!matches_identity(&source_parent_stat, &expected_source_parent) ||
        !matches_identity(&target_parent_stat, &expected_target_parent)) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-identity-mismatch", ESTALE);
    }
    if (source_parent_stat.st_dev != root_stat.st_dev || target_parent_stat.st_dev != root_stat.st_dev) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-volume-mismatch", EXDEV);
    }

    struct stat source_stat;
    if (fstatat(source_parent_fd, source_name, &source_stat, AT_SYMLINK_NOFOLLOW) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-fstatat", saved);
    }
    if (!S_ISDIR(source_stat.st_mode) || !matches_identity(&source_stat, &expected_source)) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-type-or-identity-mismatch", ESTALE);
    }
    if (source_stat.st_dev != target_parent_stat.st_dev) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-volume-mismatch", EXDEV);
    }

    struct stat target_stat;
    if (fstatat(target_parent_fd, target_name, &target_stat, AT_SYMLINK_NOFOLLOW) == 0) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("target-not-vacant", EEXIST);
    }
    if (errno != ENOENT) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("target-vacancy-fstatat", saved);
    }

    struct stat external_stat;
    memset(&external_stat, 0, sizeof(external_stat));
    if (inject) {
        if (mkdirat(target_parent_fd, target_name, 0751) != 0) {
            int saved = errno;
            close(target_parent_fd); close(source_parent_fd); close(root_fd);
            return fail("race-injection-mkdirat", saved);
        }
        if (fstatat(target_parent_fd, target_name, &external_stat, AT_SYMLINK_NOFOLLOW) != 0) {
            int saved = errno;
            close(target_parent_fd); close(source_parent_fd); close(root_fd);
            return fail("race-injection-fstatat", saved);
        }
    }

    errno = 0;
    int rename_result = renameatx_np(source_parent_fd, source_name, target_parent_fd, target_name, RENAME_EXCL);
    int rename_errno = rename_result == 0 ? 0 : errno;

    if (rename_result == 0) {
        struct stat placed_stat;
        bool identity_preserved = fstatat(target_parent_fd, target_name, &placed_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
                                  matches_identity(&placed_stat, &expected_source);
        printf("{\"operation\":\"renameatx_np\",\"flag\":\"RENAME_EXCL\",\"result\":\"placed\",\"errno\":0,\"source_dev\":\"%" PRIu64 "\",\"source_ino\":\"%" PRIu64 "\",\"destination_identity_preserved\":%s}\n",
               expected_source.dev, expected_source.ino, identity_preserved ? "true" : "false");
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        if (!identity_preserved) return fail("post-placement-source-identity-mismatch", ESTALE);
        return 0;
    }

    printf("{\"operation\":\"renameatx_np\",\"flag\":\"RENAME_EXCL\",\"result\":\"refused\",\"errno\":%d,\"errno_name\":\"%s\",\"injected_external_dev\":\"%" PRIu64 "\",\"injected_external_ino\":\"%" PRIu64 "\",\"injected_external_mode\":%u}\n",
           rename_errno, errno_name(rename_errno), (uint64_t)external_stat.st_dev,
           (uint64_t)external_stat.st_ino, (unsigned)(external_stat.st_mode & 0777));
    close(target_parent_fd); close(source_parent_fd); close(root_fd);
    if (inject && rename_errno == EEXIST) return 1;
    return fail("renameatx_np", rename_errno);
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "capabilities") == 0)
        return capabilities_command(argv[2]);
    if (argc >= 2 && strcmp(argv[1], "place") == 0)
        return place_command(argc, argv);
    fprintf(stderr, "usage: %s capabilities ABSOLUTE_ROOT | place ROOT SRC_PARENT SRC_NAME DST_PARENT DST_NAME ROOT_DEV ROOT_INO SRC_PARENT_DEV SRC_PARENT_INO DST_PARENT_DEV DST_PARENT_INO SRC_DEV SRC_INO [--race-empty-dir]\n", argv[0]);
    return 64;
}
