#define _DARWIN_C_SOURCE 1

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

#define PROTOCOL_VERSION 1
#define MAX_RECORD_BYTES (64U * 1024U)
#define RENAME_EXCL_EXPECTED 0x00000004
#define RENAME_EXCL_CAP_EXPECTED 0x00080000

#if RENAME_EXCL != RENAME_EXCL_EXPECTED
#error "The SDK RENAME_EXCL value differs from the reviewed API value"
#endif
#if VOL_CAP_INT_RENAME_EXCL != RENAME_EXCL_CAP_EXPECTED
#error "The SDK RENAME_EXCL capability value differs from the reviewed API value"
#endif

struct parser {
    const unsigned char *cursor;
    const unsigned char *end;
};

struct identity {
    uint64_t dev;
    uint64_t ino;
};

struct request {
    char library_dir[PATH_MAX];
    char stage_path[PATH_MAX];
    char target_path[PATH_MAX];
    struct identity expected_stage;
    struct identity expected_parent;
};

static void skip_space(struct parser *parser)
{
    while (parser->cursor < parser->end &&
           (*parser->cursor == ' ' || *parser->cursor == '\t' || *parser->cursor == '\r')) {
        parser->cursor++;
    }
}

static bool append_utf8(char *output, size_t capacity, size_t *length, uint32_t codepoint)
{
    unsigned char bytes[4];
    size_t count;
    if (codepoint == 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    if (codepoint <= 0x7f) {
        bytes[0] = (unsigned char)codepoint;
        count = 1;
    } else if (codepoint <= 0x7ff) {
        bytes[0] = (unsigned char)(0xc0 | (codepoint >> 6));
        bytes[1] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 2;
    } else if (codepoint <= 0xffff) {
        bytes[0] = (unsigned char)(0xe0 | (codepoint >> 12));
        bytes[1] = (unsigned char)(0x80 | ((codepoint >> 6) & 0x3f));
        bytes[2] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 3;
    } else {
        bytes[0] = (unsigned char)(0xf0 | (codepoint >> 18));
        bytes[1] = (unsigned char)(0x80 | ((codepoint >> 12) & 0x3f));
        bytes[2] = (unsigned char)(0x80 | ((codepoint >> 6) & 0x3f));
        bytes[3] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 4;
    }
    if (*length + count >= capacity) return false;
    memcpy(output + *length, bytes, count);
    *length += count;
    return true;
}

static bool read_hex_quad(struct parser *parser, uint32_t *value)
{
    if ((size_t)(parser->end - parser->cursor) < 4) return false;
    uint32_t result = 0;
    for (size_t index = 0; index < 4; index++) {
        unsigned char character = *parser->cursor++;
        result <<= 4;
        if (character >= '0' && character <= '9') result |= (uint32_t)(character - '0');
        else if (character >= 'a' && character <= 'f') result |= (uint32_t)(character - 'a' + 10);
        else if (character >= 'A' && character <= 'F') result |= (uint32_t)(character - 'A' + 10);
        else return false;
    }
    *value = result;
    return true;
}

static bool parse_string(struct parser *parser, char *output, size_t capacity)
{
    if (parser->cursor >= parser->end || *parser->cursor++ != '"') return false;
    size_t length = 0;
    while (parser->cursor < parser->end) {
        unsigned char character = *parser->cursor++;
        if (character == '"') {
            if (length >= capacity) return false;
            output[length] = '\0';
            return true;
        }
        if (character < 0x20) return false;
        if (character != '\\') {
            if (length + 1 >= capacity) return false;
            output[length++] = (char)character;
            continue;
        }
        if (parser->cursor >= parser->end) return false;
        character = *parser->cursor++;
        switch (character) {
            case '"': case '\\': case '/':
                if (length + 1 >= capacity) return false;
                output[length++] = (char)character;
                break;
            case 'b': case 'f': case 'n': case 'r': case 't': {
                char escaped = character == 'b' ? '\b' : character == 'f' ? '\f' :
                               character == 'n' ? '\n' : character == 'r' ? '\r' : '\t';
                if (length + 1 >= capacity) return false;
                output[length++] = escaped;
                break;
            }
            case 'u': {
                uint32_t codepoint;
                if (!read_hex_quad(parser, &codepoint)) return false;
                if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
                    if ((size_t)(parser->end - parser->cursor) < 6 ||
                        parser->cursor[0] != '\\' || parser->cursor[1] != 'u') return false;
                    parser->cursor += 2;
                    uint32_t low;
                    if (!read_hex_quad(parser, &low) || low < 0xdc00 || low > 0xdfff) return false;
                    codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
                }
                if (!append_utf8(output, capacity, &length, codepoint)) return false;
                break;
            }
            default:
                return false;
        }
    }
    return false;
}

static bool expect_character(struct parser *parser, unsigned char expected)
{
    skip_space(parser);
    if (parser->cursor >= parser->end || *parser->cursor != expected) return false;
    parser->cursor++;
    return true;
}

static bool parse_decimal_u64(const char *text, uint64_t *value)
{
    if (text[0] == '\0' || (text[0] == '0' && text[1] != '\0')) return false;
    for (const char *cursor = text; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') return false;
    }
    errno = 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') return false;
    *value = (uint64_t)parsed;
    return true;
}

static bool parse_identity(struct parser *parser, struct identity *identity)
{
    char key[16];
    char value[32];
    bool have_dev = false;
    bool have_ino = false;
    if (!expect_character(parser, '{')) return false;
    skip_space(parser);
    if (parser->cursor < parser->end && *parser->cursor == '}') {
        parser->cursor++;
        return false;
    }
    for (;;) {
        if (!parse_string(parser, key, sizeof(key)) || !expect_character(parser, ':')) return false;
        if (!parse_string(parser, value, sizeof(value))) return false;
        if (strcmp(key, "dev") == 0 && !have_dev) {
            if (!parse_decimal_u64(value, &identity->dev)) return false;
            have_dev = true;
        } else if (strcmp(key, "ino") == 0 && !have_ino) {
            if (!parse_decimal_u64(value, &identity->ino)) return false;
            have_ino = true;
        } else {
            return false;
        }
        skip_space(parser);
        if (parser->cursor < parser->end && *parser->cursor == '}') {
            parser->cursor++;
            return have_dev && have_ino;
        }
        if (!expect_character(parser, ',')) return false;
    }
}

static bool parse_version(struct parser *parser)
{
    skip_space(parser);
    if (parser->cursor >= parser->end || *parser->cursor++ != '1') return false;
    skip_space(parser);
    return parser->cursor < parser->end && (*parser->cursor == ',' || *parser->cursor == '}');
}

static bool parse_request(const unsigned char *bytes, size_t length, struct request *request)
{
    struct parser parser = { .cursor = bytes, .end = bytes + length };
    char key[32];
    char value[PATH_MAX];
    bool have_version = false;
    bool have_operation = false;
    bool have_library = false;
    bool have_stage = false;
    bool have_target = false;
    bool have_expected_stage = false;
    bool have_expected_parent = false;

    if (!expect_character(&parser, '{')) return false;
    for (;;) {
        if (!parse_string(&parser, key, sizeof(key)) || !expect_character(&parser, ':')) return false;
        if (strcmp(key, "protocolVersion") == 0) {
            if (have_version || !parse_version(&parser)) return false;
            have_version = true;
        } else if (strcmp(key, "operation") == 0) {
            if (have_operation || !parse_string(&parser, value, sizeof(value)) ||
                strcmp(value, "renameExclusiveReviewedSource") != 0) return false;
            have_operation = true;
        } else if (strcmp(key, "libraryDir") == 0) {
            if (have_library || !parse_string(&parser, request->library_dir, sizeof(request->library_dir))) return false;
            have_library = true;
        } else if (strcmp(key, "stagePath") == 0) {
            if (have_stage || !parse_string(&parser, request->stage_path, sizeof(request->stage_path))) return false;
            have_stage = true;
        } else if (strcmp(key, "targetPath") == 0) {
            if (have_target || !parse_string(&parser, request->target_path, sizeof(request->target_path))) return false;
            have_target = true;
        } else if (strcmp(key, "expectedStage") == 0) {
            if (have_expected_stage || !parse_identity(&parser, &request->expected_stage)) return false;
            have_expected_stage = true;
        } else if (strcmp(key, "expectedParent") == 0) {
            if (have_expected_parent || !parse_identity(&parser, &request->expected_parent)) return false;
            have_expected_parent = true;
        } else {
            return false;
        }
        skip_space(&parser);
        if (parser.cursor < parser.end && *parser.cursor == '}') {
            parser.cursor++;
            break;
        }
        if (!expect_character(&parser, ',')) return false;
    }
    skip_space(&parser);
    return parser.cursor == parser.end && have_version && have_operation && have_library && have_stage &&
           have_target && have_expected_stage && have_expected_parent;
}

static bool parse_input(struct request *request)
{
    unsigned char bytes[MAX_RECORD_BYTES + 1];
    size_t length = 0;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, bytes + length, sizeof(bytes) - length);
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        length += (size_t)count;
        if (length == sizeof(bytes)) return false;
    }
    if (length < 2 || length > MAX_RECORD_BYTES || bytes[length - 1] != '\n' ||
        memchr(bytes, '\n', length - 1) != NULL || memchr(bytes, '\r', length - 1) != NULL) return false;
    return parse_request(bytes, length - 1, request);
}

static int emit_error(const char *code, int error_number)
{
    (void)printf("{\"protocolVersion\":%d,\"ok\":false,\"error\":{\"code\":\"%s\",\"errno\":%d}}\n",
                 PROTOCOL_VERSION, code, error_number);
    (void)fflush(stdout);
    return 1;
}

static int emit_success(void)
{
    (void)printf("{\"protocolVersion\":%d,\"ok\":true}\n", PROTOCOL_VERSION);
    (void)fflush(stdout);
    return 0;
}

static bool same_identity(const struct stat *info, const struct identity *identity)
{
    return (uint64_t)info->st_dev == identity->dev && (uint64_t)info->st_ino == identity->ino;
}

static bool safe_component(const char *component, size_t length)
{
    return length > 0 && length <= NAME_MAX &&
           !(length == 1 && component[0] == '.') &&
           !(length == 2 && component[0] == '.' && component[1] == '.');
}

static bool canonical_root(const char *input, char resolved[PATH_MAX])
{
    if (input[0] != '/' || input[0] == '\0') return false;
    if (realpath(input, resolved) == NULL || strcmp(input, resolved) != 0) return false;
    return true;
}

static int open_root_directory(const char *canonical_path)
{
    int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0) return -1;
    const char *cursor = canonical_path + 1;
    while (*cursor != '\0') {
        const char *slash = strchr(cursor, '/');
        size_t length = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
        if (!safe_component(cursor, length)) {
            close(current);
            errno = EINVAL;
            return -1;
        }
        char component[NAME_MAX + 1];
        memcpy(component, cursor, length);
        component[length] = '\0';
        int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current);
            errno = saved;
            return -1;
        }
        close(current);
        current = next;
        if (slash == NULL) break;
        cursor = slash + 1;
        if (*cursor == '\0') {
            close(current);
            errno = EINVAL;
            return -1;
        }
    }
    return current;
}

static bool split_beneath_root(const char *root, const char *absolute_path,
                               char parent_relative[PATH_MAX], char basename[NAME_MAX + 1])
{
    if (absolute_path[0] != '/') return false;
    const char *relative;
    if (strcmp(root, "/") == 0) {
        relative = absolute_path + 1;
    } else {
        size_t root_length = strlen(root);
        if (strncmp(root, absolute_path, root_length) != 0 || absolute_path[root_length] != '/') return false;
        relative = absolute_path + root_length + 1;
    }
    if (*relative == '\0') return false;

    const char *last_slash = strrchr(relative, '/');
    const char *base = last_slash == NULL ? relative : last_slash + 1;
    size_t base_length = strlen(base);
    if (!safe_component(base, base_length)) return false;
    memcpy(basename, base, base_length);
    basename[base_length] = '\0';

    size_t parent_length = last_slash == NULL ? 0 : (size_t)(last_slash - relative);
    if (parent_length == 0) {
        memcpy(parent_relative, ".", 2);
    } else {
        if (parent_length >= PATH_MAX) return false;
        size_t component_start = 0;
        for (size_t index = 0; index <= parent_length; index++) {
            if (index == parent_length || relative[index] == '/') {
                if (!safe_component(relative + component_start, index - component_start)) return false;
                component_start = index + 1;
            }
        }
        memcpy(parent_relative, relative, parent_length);
        parent_relative[parent_length] = '\0';
    }
    return true;
}

static int open_beneath_directory(int root_fd, const char *relative_path)
{
    if (strcmp(relative_path, ".") == 0) return dup(root_fd);
    int current = dup(root_fd);
    if (current < 0) return -1;
    const char *cursor = relative_path;
    while (*cursor != '\0') {
        const char *slash = strchr(cursor, '/');
        size_t length = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
        if (!safe_component(cursor, length)) {
            close(current);
            errno = EINVAL;
            return -1;
        }
        char component[NAME_MAX + 1];
        memcpy(component, cursor, length);
        component[length] = '\0';
        int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current);
            errno = saved;
            return -1;
        }
        close(current);
        current = next;
        if (slash == NULL) break;
        cursor = slash + 1;
        if (*cursor == '\0') {
            close(current);
            errno = EINVAL;
            return -1;
        }
    }
    return current;
}

static bool query_exclusive_rename_capability(const char *root_path, dev_t expected_device)
{
    struct attrlist attributes;
    memset(&attributes, 0, sizeof(attributes));
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.volattr = ATTR_VOL_CAPABILITIES;
    struct {
        uint32_t length;
        vol_capabilities_attr_t capabilities;
    } response;
    memset(&response, 0, sizeof(response));
    if (getattrlist(root_path, &attributes, &response, sizeof(response), FSOPT_NOFOLLOW) != 0) return false;
    if (response.length < sizeof(response)) {
        errno = EIO;
        return false;
    }
    struct stat root_info;
    if (stat(root_path, &root_info) != 0) return false;
    if (root_info.st_dev != expected_device) {
        errno = EXDEV;
        return false;
    }
    uint32_t bit = VOL_CAP_INT_RENAME_EXCL;
    if ((response.capabilities.valid[VOL_CAPABILITIES_INTERFACES] & bit) == 0 ||
        (response.capabilities.capabilities[VOL_CAPABILITIES_INTERFACES] & bit) == 0) {
        errno = ENOTSUP;
        return false;
    }
    return true;
}

static int check_exclusive_rename_capability(const char *input_path)
{
    char root_path[PATH_MAX];
    if (!canonical_root(input_path, root_path)) return emit_error("unsafe-path", EINVAL);
    int root_fd = open_root_directory(root_path);
    if (root_fd < 0) return emit_error("filesystem-error", errno);
    struct stat root_info;
    if (fstat(root_fd, &root_info) != 0) {
        int saved = errno;
        close(root_fd);
        return emit_error("filesystem-error", saved);
    }
    if (!query_exclusive_rename_capability(root_path, root_info.st_dev)) {
        int saved = errno;
        close(root_fd);
        return emit_error(saved == ENOTSUP ? "unsupported-volume" : "filesystem-error", saved);
    }
    close(root_fd);
    return emit_success();
}

static bool destination_is_vacant(int parent_fd, const char *name)
{
    struct stat ignored;
    if (fstatat(parent_fd, name, &ignored, AT_SYMLINK_NOFOLLOW) == 0) {
        errno = EEXIST;
        return false;
    }
    return errno == ENOENT;
}

static bool read_stage_identity(int parent_fd, const char *name, const struct identity *expected,
                                struct stat *stage_info)
{
    if (fstatat(parent_fd, name, stage_info, AT_SYMLINK_NOFOLLOW) != 0) return false;
    if (!same_identity(stage_info, expected) ||
        (!S_ISDIR(stage_info->st_mode) && !S_ISREG(stage_info->st_mode))) {
        errno = ESTALE;
        return false;
    }
    return true;
}

static int place_source(const struct request *request, bool inject_collision)
{
    char root_path[PATH_MAX];
    char stage_parent_relative[PATH_MAX];
    char target_parent_relative[PATH_MAX];
    char stage_basename[NAME_MAX + 1];
    char target_basename[NAME_MAX + 1];
    if (!canonical_root(request->library_dir, root_path) ||
        !split_beneath_root(root_path, request->stage_path, stage_parent_relative, stage_basename) ||
        !split_beneath_root(root_path, request->target_path, target_parent_relative, target_basename) ||
        strcmp(request->stage_path, request->target_path) == 0) {
        return emit_error("unsafe-path", EINVAL);
    }

    int root_fd = open_root_directory(root_path);
    if (root_fd < 0) return emit_error("unsafe-path", errno);
    struct stat root_info;
    if (fstat(root_fd, &root_info) != 0) {
        int saved = errno;
        close(root_fd);
        return emit_error("filesystem-error", saved);
    }

    int stage_parent_fd = open_beneath_directory(root_fd, stage_parent_relative);
    if (stage_parent_fd < 0) {
        int saved = errno;
        close(root_fd);
        return emit_error(saved == ELOOP || saved == ENOTDIR || saved == EINVAL ? "unsafe-path" : "filesystem-error", saved);
    }
    int target_parent_fd = open_beneath_directory(root_fd, target_parent_relative);
    if (target_parent_fd < 0) {
        int saved = errno;
        close(stage_parent_fd);
        close(root_fd);
        return emit_error(saved == ELOOP || saved == ENOTDIR || saved == EINVAL ? "unsafe-path" : "filesystem-error", saved);
    }

    struct stat stage_parent_info;
    struct stat target_parent_info;
    if (fstat(stage_parent_fd, &stage_parent_info) != 0 || fstat(target_parent_fd, &target_parent_info) != 0) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("filesystem-error", saved);
    }
    if (!same_identity(&target_parent_info, &request->expected_parent) ||
        stage_parent_info.st_dev != root_info.st_dev || target_parent_info.st_dev != root_info.st_dev) {
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("parent-identity-mismatch", ESTALE);
    }
    if (!query_exclusive_rename_capability(root_path, root_info.st_dev)) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error(saved == ENOTSUP ? "unsupported-volume" : "filesystem-error", saved);
    }

    struct stat stage_info;
    if (!read_stage_identity(stage_parent_fd, stage_basename, &request->expected_stage, &stage_info)) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("stage-identity-mismatch", saved);
    }
    if (stage_info.st_dev != root_info.st_dev || stage_info.st_dev != target_parent_info.st_dev) {
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("filesystem-error", EXDEV);
    }
    if (!destination_is_vacant(target_parent_fd, target_basename)) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error(saved == EEXIST ? "destination-exists" : "filesystem-error", saved);
    }

    struct stat current_stage_info;
    if (!read_stage_identity(stage_parent_fd, stage_basename, &request->expected_stage, &current_stage_info)) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("stage-identity-mismatch", saved);
    }
    if (!same_identity(&target_parent_info, &request->expected_parent)) {
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("parent-identity-mismatch", ESTALE);
    }

#ifdef COPI_NATIVE_TEST_HOOKS
    if (inject_collision) {
        if (mkdirat(target_parent_fd, target_basename, 0700) != 0) {
            int saved = errno;
            close(target_parent_fd);
            close(stage_parent_fd);
            close(root_fd);
            return emit_error("filesystem-error", saved);
        }
    }
#else
    (void)inject_collision;
#endif

    if (renameatx_np(stage_parent_fd, stage_basename, target_parent_fd, target_basename, RENAME_EXCL) != 0) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error(saved == EEXIST ? "destination-exists" : "filesystem-error", saved);
    }

    struct stat placed_info;
    if (fstatat(target_parent_fd, target_basename, &placed_info, AT_SYMLINK_NOFOLLOW) != 0) {
        int saved = errno;
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("post-placement-identity-mismatch", saved);
    }
    if (!same_identity(&placed_info, &request->expected_stage)) {
        close(target_parent_fd);
        close(stage_parent_fd);
        close(root_fd);
        return emit_error("post-placement-identity-mismatch", ESTALE);
    }
    close(target_parent_fd);
    close(stage_parent_fd);
    close(root_fd);
    return emit_success();
}

/* Protocol v1 uses argv ["--protocol-version", "1"] and one newline-terminated
 * JSON object on stdin. Success/failure is one bounded JSON record on stdout.
 * The operation and RENAME_EXCL flag are fixed by this binary, never supplied by input.
 */
int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "--check-exclusive-rename") == 0) {
        return check_exclusive_rename_capability(argv[2]);
    }

    bool inject_collision = false;
#ifdef COPI_NATIVE_TEST_HOOKS
    if (argc == 4 && strcmp(argv[1], "--protocol-version") == 0 && strcmp(argv[2], "1") == 0 &&
        strcmp(argv[3], "--test-insert-empty-directory-collision") == 0) {
        inject_collision = true;
    } else
#endif
    if (argc != 3 || strcmp(argv[1], "--protocol-version") != 0) {
        return emit_error("invalid-request", EINVAL);
    } else if (strcmp(argv[2], "1") != 0) {
        return emit_error("unsupported-protocol", EINVAL);
    }

    struct request request;
    memset(&request, 0, sizeof(request));
    if (!parse_input(&request)) return emit_error("invalid-request", EINVAL);
    return place_source(&request, inject_collision);
}
